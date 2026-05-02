import type { AppConfig } from '../config.ts';
import { GatewayError, invalidRequestError, jsonResponse, unsupportedCapabilityError, upstreamError } from '../errors.ts';
import { applyFieldPolicy, withFieldWarning } from '../field-policy.ts';
import { normalizeMessages } from '../normalize/messages.ts';
import { parseSSEJson, parseSSEStream, streamHeaders } from '../normalize/stream.ts';
import { normalizeTools } from '../normalize/tools.ts';
import { samplingDefaultsFor } from '../profile.ts';
import { normalizeOpenAIResponseFormat } from './response-format.ts';
import { upstreamFetch, upstreamHttpError, upstreamJson } from '../upstream/llama.ts';

type JsonObject = Record<string, any>;

export class ResponseStore {
  private items = new Map<string, { response: JsonObject; expiresAt: number }>();

  save(response: JsonObject, ttlMs: number): void {
    this.items.set(response.id, { response: structuredClone(response), expiresAt: Date.now() + ttlMs });
  }

  get(id: string): JsonObject | undefined {
    this.prune();
    return structuredClone(this.items.get(id)?.response);
  }

  delete(id: string): boolean {
    this.prune();
    return this.items.delete(id);
  }

  private prune() {
    const now = Date.now();
    for (const [id, entry] of this.items) {
      if (entry.expiresAt <= now) this.items.delete(id);
    }
  }
}

export async function createResponse(config: AppConfig, store: ResponseStore, body: unknown): Promise<Response> {
  if (!isObject(body)) throw invalidRequestError('JSON body must be an object');
  const { body: normalized, strippedFields } = applyFieldPolicy('openai_responses', body, config);
  if (typeof normalized.previous_response_id === 'string' && !store.get(normalized.previous_response_id)) {
    throw new GatewayError(404, `Response ${normalized.previous_response_id} was not found`);
  }
  const chatRequest = responseRequestToChat(normalized, config);
  if (normalized.stream === true) return withFieldWarning(await streamResponse(config, chatRequest), strippedFields, config);

  const chat = await upstreamJson(config, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatRequest),
  });
  const response = chatCompletionToResponse(chat, normalized);
  if (normalized.store !== false) {
    store.save(response, config.completionTtlMs);
  }
  return withFieldWarning(jsonResponse(response), strippedFields, config);
}

export function getResponse(store: ResponseStore, id: string): Response {
  const response = store.get(id);
  if (!response) throw new GatewayError(404, `Response ${id} was not found`);
  return jsonResponse(response);
}

export function deleteResponse(store: ResponseStore, id: string): Response {
  if (!store.delete(id)) throw new GatewayError(404, `Response ${id} was not found`);
  return jsonResponse({ id, object: 'response.deleted', deleted: true });
}

function responseRequestToChat(input: JsonObject, config: AppConfig): JsonObject {
  const messages: JsonObject[] = [];
  if (typeof input.instructions === 'string' && input.instructions.length > 0) {
    messages.push({ role: 'system', content: input.instructions });
  }
  if (typeof input.input === 'string') {
    messages.push({ role: 'user', content: input.input });
  } else if (Array.isArray(input.input)) {
    messages.push(...normalizeResponseInput(input.input, config));
  } else {
    throw invalidRequestError('input must be a string or message array');
  }

  const chat: JsonObject = { ...input, messages };
  if (input.max_output_tokens !== undefined) chat.max_tokens = input.max_output_tokens;
  delete chat.instructions;
  delete chat.input;
  delete chat.max_output_tokens;
  delete chat.previous_response_id;
  delete chat.store;
  rejectHostedResponsesTools(chat.tools);
  applySamplingDefaults(chat, samplingDefaultsFor(config));
  normalizeTools(chat);
  normalizeOpenAIResponseFormat(chat, config);
  return chat;
}

function applySamplingDefaults(body: JsonObject, defaults: AppConfig['samplingDefaults']): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (value !== undefined && body[key] === undefined) body[key] = value;
  }
}

function chatCompletionToResponse(chat: unknown, request: JsonObject): JsonObject {
  if (!isObject(chat)) throw upstreamError('bad_response', 'Upstream returned invalid completion');
  const choice = Array.isArray(chat.choices) ? chat.choices[0] : undefined;
  const message = isObject(choice?.message) ? choice.message : {};
  const output: JsonObject[] = [{
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [],
  }];
  if (typeof message.content === 'string' && message.content.length > 0) {
    output[0].content.push({ type: 'output_text', text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      output[0].content.push({
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.function?.name,
        arguments: toolCall.function?.arguments ?? '{}',
      });
    }
  }
  return {
    id: `resp_${crypto.randomUUID()}`,
    object: 'response',
    created_at: typeof chat.created === 'number' ? chat.created : Math.floor(Date.now() / 1000),
    model: typeof chat.model === 'string' ? chat.model : request.model,
    status: 'completed',
    output,
    previous_response_id: typeof request.previous_response_id === 'string' ? request.previous_response_id : undefined,
    metadata: isObject(request.metadata) ? request.metadata : undefined,
    usage: normalizeResponsesUsage(chat.usage),
  };
}

async function streamResponse(config: AppConfig, chatRequest: JsonObject): Promise<Response> {
  const upstream = await upstreamFetch(config, '/v1/chat/completions', {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(chatRequest),
  });
  if (!upstream.response.ok || !upstream.response.body) {
    throw upstream.response.body ? await upstreamHttpError(upstream.response) : upstreamError('bad_response', 'Upstream returned an empty stream');
  }

  const responseId = `resp_${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(sse('response.created', {
        type: 'response.created',
        response: {
          id: responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: chatRequest.model,
          status: 'in_progress',
          output: [],
        },
      })));
      let failed = false;
      try {
        for await (const frame of parseSSEStream(upstream.response.body!)) {
          if (frame.data === '[DONE]') break;
          const chunk = parseSSEJson(frame);
          const delta = chunk.choices?.[0]?.delta;
          if (typeof delta?.content === 'string') {
            controller.enqueue(encoder.encode(sse('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: responseId,
              output_index: 0,
              content_index: 0,
              delta: delta.content,
            })));
          }
        }
      } catch (error) {
        failed = true;
        controller.enqueue(encoder.encode(sse('response.failed', {
          type: 'response.failed',
          response: { id: responseId, object: 'response', status: 'failed' },
          error: { message: error instanceof Error ? error.message : 'Upstream stream failed' },
        })));
      }
      if (!failed) {
        controller.enqueue(encoder.encode(sse('response.completed', {
          type: 'response.completed',
          response: { id: responseId, object: 'response', status: 'completed' },
        })));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: streamHeaders() });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function normalizeResponseInput(input: unknown[], config: AppConfig): JsonObject[] {
  return normalizeMessages(input.map((message) => normalizeResponseInputMessage(message)), config);
}

function normalizeResponseInputMessage(message: unknown): unknown {
  if (!isObject(message) || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (!isObject(part) || typeof part.type !== 'string') return part;
      if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
        return { type: 'text', text: part.text };
      }
      if (part.type === 'input_image' && typeof part.image_url === 'string') {
        return { type: 'image_url', image_url: { url: part.image_url } };
      }
      return part;
    }),
  };
}

function rejectHostedResponsesTools(tools: unknown): void {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (isObject(tool) && typeof tool.type === 'string' && tool.type !== 'function') {
      throw unsupportedCapabilityError(`${tool.type} tools are not supported by this local llama.cpp backend`);
    }
  }
}

function normalizeResponsesUsage(usage: unknown): JsonObject | undefined {
  if (!isObject(usage)) return undefined;
  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
