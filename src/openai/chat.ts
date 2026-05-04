import type { AppConfig } from '../config.ts';
import { GatewayError, invalidRequestError, jsonResponse, unsupportedCapabilityError, upstreamError } from '../errors.ts';
import { applyFieldPolicy, withFieldWarning } from '../field-policy.ts';
import { ensureOpenAIStreamDone, streamHeaders } from '../normalize/stream.ts';
import { upstreamFetch, upstreamHttpError } from '../upstream/llama.ts';
import { createLogger } from '../logger.ts';
import { logStreamingResponseDiagnostics, logUpstreamPayloadDiagnostics } from '../truncation-diagnostics.ts';
import { canonicalToUpstreamChatRequest, openAIChatRequestToCanonical } from '../internal/openai-chat.ts';
import { canonicalToOpenAIChatCompletion, upstreamChatCompletionToCanonical } from '../internal/response.ts';

type JsonObject = Record<string, any>;

export type StoredCompletion = {
  completion: JsonObject;
  messages: JsonObject[];
  expiresAt: number;
  createdOrder: number;
};

export class CompletionStore {
  private items = new Map<string, StoredCompletion>();
  private sequence = 0;

  save(completion: JsonObject, messages: JsonObject[], ttlMs: number): void {
    this.items.set(completion.id, {
      completion: structuredClone(completion),
      messages: structuredClone(messages),
      expiresAt: Date.now() + ttlMs,
      createdOrder: this.sequence++,
    });
  }

  get(id: string): StoredCompletion | undefined {
    this.prune();
    return this.items.get(id);
  }

  delete(id: string): boolean {
    this.prune();
    return this.items.delete(id);
  }

  list(query: URLSearchParams): JsonObject[] {
    this.prune();
    let rows = [...this.items.values()]
      .sort((a, b) => a.createdOrder - b.createdOrder)
      .map((entry) => structuredClone(entry.completion));

    const model = query.get('model');
    if (model) rows = rows.filter((row) => row.model === model);
    for (const [key, value] of query) {
      if (key.startsWith('metadata.')) {
        const name = key.slice('metadata.'.length);
        rows = rows.filter((row) => row.metadata?.[name] === value);
      }
    }
    if (query.get('order') === 'desc') rows.reverse();
    const after = query.get('after');
    if (after) {
      const index = rows.findIndex((row) => row.id === after);
      if (index >= 0) rows = rows.slice(index + 1);
    }
    const limit = Number.parseInt(query.get('limit') ?? '20', 10);
    return rows.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 20);
  }

  private prune() {
    const now = Date.now();
    for (const [id, entry] of this.items) {
      if (entry.expiresAt <= now) this.items.delete(id);
    }
  }
}

export async function createChatCompletion(config: AppConfig, store: CompletionStore, body: unknown): Promise<Response> {
  const logger = createLogger(config.logLevel);
  if (!isObject(body)) throw invalidRequestError('JSON body must be an object');
  const original = body;
  const { body: normalized, strippedFields } = normalizeChatRequest(original, config);
  logUpstreamPayloadDiagnostics(logger, {
    route: '/v1/chat/completions',
    upstream_route: '/v1/chat/completions',
    payload: normalized,
  });

  if (normalized.stream === true) return withFieldWarning(await streamChatCompletion(config, normalized), strippedFields, config);

  const upstreamRes = await upstreamFetch(config, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(normalized),
  });
  if (!upstreamRes.response.ok) throw await upstreamHttpError(upstreamRes.response);
  const upstreamText = await upstreamRes.response.text();
  const upstreamBytes = Buffer.byteLength(upstreamText);
  let upstream: unknown;
  try {
    upstream = JSON.parse(upstreamText);
  } catch {
    throw upstreamError('bad_response', 'Upstream returned invalid JSON');
  }
  const completion = normalizeCompletion(upstream, normalized.model, original.metadata);
  if (original.store === true) {
    store.save(completion, normalized.messages, config.completionTtlMs);
  }
  const response = withFieldWarning(jsonResponse(completion), strippedFields, config);
  response.headers.set('x-relay-internal-upstream-bytes', String(upstreamBytes));
  return response;
}

export async function createCompletionShim(config: AppConfig, store: CompletionStore, body: unknown): Promise<Response> {
  if (!isObject(body)) throw invalidRequestError('JSON body must be an object');
  const chatBody = completionRequestToChat(body);
  const chatResponse = await createChatCompletion(config, store, chatBody);
  if (chatBody.stream === true) return chatResponse;
  const chat = await chatResponse.json();
  return jsonResponse(chatCompletionToTextCompletion(chat, body));
}

export function listStoredCompletions(store: CompletionStore, url: URL): Response {
  const data = store.list(url.searchParams);
  return jsonResponse(listShape(data));
}

export function getStoredCompletion(store: CompletionStore, id: string): Response {
  const entry = store.get(id);
  if (!entry) throw new GatewayError(404, `Stored completion ${id} was not found`);
  return jsonResponse(entry.completion);
}

export async function updateStoredCompletion(store: CompletionStore, id: string, body: unknown): Promise<Response> {
  if (!isObject(body)) throw invalidRequestError('JSON body must be an object');
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'metadata')) {
    throw new GatewayError(400, 'Only metadata can be updated on stored completions');
  }
  const entry = store.get(id);
  if (!entry) throw new GatewayError(404, `Stored completion ${id} was not found`);
  entry.completion.metadata = isObject(body.metadata) ? body.metadata : {};
  return jsonResponse(entry.completion);
}

export function deleteStoredCompletion(store: CompletionStore, id: string): Response {
  if (!store.delete(id)) throw new GatewayError(404, `Stored completion ${id} was not found`);
  return jsonResponse({ id, deleted: true, object: 'chat.completion.deleted' });
}

export function getStoredMessages(store: CompletionStore, id: string, url: URL): Response {
  const entry = store.get(id);
  if (!entry) throw new GatewayError(404, `Stored completion ${id} was not found`);
  let data = structuredClone(entry.messages);
  if (url.searchParams.get('order') === 'desc') data.reverse();
  const after = url.searchParams.get('after');
  if (after) {
    const index = data.findIndex((message) => message.id === after);
    if (index >= 0) data = data.slice(index + 1);
  }
  const limit = Number.parseInt(url.searchParams.get('limit') ?? `${data.length || 20}`, 10);
  data = data.slice(0, Number.isFinite(limit) && limit > 0 ? limit : data.length);
  return jsonResponse(listShape(data));
}

function completionRequestToChat(input: JsonObject): JsonObject {
  const chat: JsonObject = {};
  for (const key of [
    'model', 'temperature', 'top_p', 'max_tokens', 'stream', 'stream_options', 'stop',
    'frequency_penalty', 'presence_penalty', 'seed', 'n', 'logprobs', 'metadata', 'user',
  ]) {
    if (input[key] !== undefined) chat[key] = input[key];
  }
  chat.messages = [{ role: 'user', content: normalizePrompt(input.prompt) }];
  return chat;
}

function normalizePrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) return prompt.map((item) => typeof item === 'string' ? item : String(item ?? '')).join('\n');
  if (prompt === undefined || prompt === null) return '';
  return String(prompt);
}

function chatCompletionToTextCompletion(chat: JsonObject, original: JsonObject): JsonObject {
  return {
    id: typeof chat.id === 'string' ? chat.id : `cmpl-${crypto.randomUUID()}`,
    object: 'text_completion',
    created: typeof chat.created === 'number' ? chat.created : Math.floor(Date.now() / 1000),
    model: chat.model ?? original.model,
    choices: Array.isArray(chat.choices) ? chat.choices.map((choice: JsonObject) => ({
      text: typeof choice?.message?.content === 'string' ? choice.message.content : '',
      index: typeof choice?.index === 'number' ? choice.index : 0,
      logprobs: choice?.logprobs ?? null,
      finish_reason: choice?.finish_reason ?? null,
    })) : [],
    usage: chat.usage,
  };
}

function normalizeChatRequest(input: JsonObject, config: AppConfig): { body: JsonObject; strippedFields: string[] } {
  const { body, strippedFields } = applyFieldPolicy('openai_chat', input, config);
  const canonical = openAIChatRequestToCanonical(body, config);
  const upstreamBody = canonicalToUpstreamChatRequest(canonical);
  delete upstreamBody.store;
  return { body: upstreamBody, strippedFields };
}

async function streamChatCompletion(config: AppConfig, body: JsonObject): Promise<Response> {
  const logger = createLogger(config.logLevel);
  const includeUsage = isObject(body.stream_options) && body.stream_options.include_usage === true;
  const upstream = await upstreamFetch(config, '/v1/chat/completions', {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!upstream.response.ok) {
    throw await upstreamHttpError(upstream.response);
  }
  if (!upstream.response.body) {
    throw upstreamError('bad_response', 'Upstream returned an empty stream');
  }
  let upstreamEvents = 0;
  let downstreamEvents = 0;
  let upstreamBytes = 0;
  let downstreamBytes = 0;
  let sawDone = false;
  let endedCleanly = false;
  const instrumented = ensureOpenAIStreamDone(upstream.response.body, includeUsage, {
    onUpstreamFrame: (frame) => {
      upstreamEvents += 1;
      upstreamBytes += Buffer.byteLength(frame.data) + (frame.event ? Buffer.byteLength(frame.event) : 0);
      if (frame.data === '[DONE]') sawDone = true;
    },
    onDownstreamChunk: (chunk) => {
      downstreamEvents += 1;
      downstreamBytes += Buffer.byteLength(chunk);
    },
    onUpstreamComplete: (clean) => {
      endedCleanly = clean;
    },
  });
  const response = new Response(instrumented, {
    status: 200,
    headers: streamHeaders(),
  });
  queueMicrotask(() => {
    logStreamingResponseDiagnostics(logger, {
      route: '/v1/chat/completions',
      upstream_sse_events_received: upstreamEvents,
      downstream_sse_events_emitted: downstreamEvents,
      upstream_bytes_received: upstreamBytes,
      downstream_bytes_emitted: downstreamBytes,
      final_done_marker_observed: sawDone,
      upstream_ended_cleanly: endedCleanly,
    });
  });
  return response;
}

function normalizeCompletion(raw: unknown, requestedModel: unknown, metadata: unknown): JsonObject {
  const canonical = upstreamChatCompletionToCanonical(raw, requestedModel);
  const completion = canonicalToOpenAIChatCompletion(canonical, metadata);
  for (const choice of completion.choices ?? []) validateAssistantChoice(choice);
  return completion;
}

function validateAssistantChoice(choice: JsonObject): void {
  const message = choice.message ?? {};
  const hasContent = typeof message.content === 'string' ? message.content.length > 0 : message.content !== null && message.content !== undefined;
  const hasRefusal = typeof message.refusal === 'string' && message.refusal.length > 0;
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const hasFunction = isObject(message.function_call);
  if (!hasContent && !hasRefusal && !hasTools && !hasFunction && choice.finish_reason !== 'stop') {
    throw upstreamError('bad_response', 'Upstream returned an empty assistant response');
  }
}

function listShape(data: JsonObject[]): JsonObject {
  return {
    object: 'list',
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: false,
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
