import type { CanonicalAssistantMessage, CanonicalChatResponse, CanonicalChoice, CanonicalToolCall, CanonicalUsage } from './canonical.ts';
import { openAIMessageToAnthropicContent, normalizeOpenAIToolCalls } from '../normalize/tools.ts';
import { upstreamError } from '../errors.ts';

type JsonObject = Record<string, any>;

export function upstreamChatCompletionToCanonical(upstream: unknown, requestedModel: unknown): CanonicalChatResponse {
  if (!isObject(upstream)) throw upstreamError('bad_response', 'Upstream returned invalid completion');
  const canonical: CanonicalChatResponse = {
    id: typeof upstream.id === 'string' ? upstream.id : `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: typeof upstream.created === 'number' ? upstream.created : Math.floor(Date.now() / 1000),
    model: typeof upstream.model === 'string' ? upstream.model : (typeof requestedModel === 'string' ? requestedModel : undefined),
    choices: Array.isArray(upstream.choices) ? upstream.choices.map(normalizeChoice) : [],
  };
  if (isObject(upstream.usage)) {
    canonical.usage = {
      prompt_tokens: typeof upstream.usage.prompt_tokens === 'number' ? upstream.usage.prompt_tokens : undefined,
      completion_tokens: typeof upstream.usage.completion_tokens === 'number' ? upstream.usage.completion_tokens : undefined,
      total_tokens: typeof upstream.usage.total_tokens === 'number' ? upstream.usage.total_tokens : undefined,
    };
  }
  if (upstream.system_fingerprint !== undefined) canonical.system_fingerprint = upstream.system_fingerprint;
  if (canonical.choices.length === 0) throw upstreamError('bad_response', 'Upstream returned no choices');
  return canonical;
}

export function canonicalToOpenAIChatCompletion(canonical: CanonicalChatResponse, metadata?: unknown): JsonObject {
  const completion: JsonObject = {
    id: canonical.id,
    object: 'chat.completion',
    created: canonical.created,
    model: canonical.model,
    choices: canonical.choices.map((choice) => ({
      index: choice.index,
      message: toOpenAIMessage(choice.message),
      finish_reason: choice.finish_reason,
      logprobs: choice.logprobs ?? null,
    })),
  };
  if (canonical.usage !== undefined) completion.usage = canonical.usage;
  if (canonical.system_fingerprint !== undefined) completion.system_fingerprint = canonical.system_fingerprint;
  if (isObject(metadata)) completion.metadata = metadata;
  return completion;
}

export function canonicalToOpenAIResponse(canonical: CanonicalChatResponse, request: JsonObject): JsonObject {
  const choice = canonical.choices[0];
  const output: JsonObject[] = [{
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [],
  }];
  if (choice?.message.content) output[0].content.push({ type: 'output_text', text: choice.message.content });
  for (const toolCall of choice?.message.tool_calls ?? []) {
    output[0].content.push({
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }

  return {
    id: `resp_${crypto.randomUUID()}`,
    object: 'response',
    created_at: canonical.created,
    model: canonical.model,
    status: 'completed',
    output,
    previous_response_id: typeof request.previous_response_id === 'string' ? request.previous_response_id : undefined,
    metadata: isObject(request.metadata) ? request.metadata : undefined,
    usage: canonical.usage ? {
      input_tokens: canonical.usage.prompt_tokens ?? 0,
      output_tokens: canonical.usage.completion_tokens ?? 0,
      total_tokens: canonical.usage.total_tokens ?? ((canonical.usage.prompt_tokens ?? 0) + (canonical.usage.completion_tokens ?? 0)),
    } : undefined,
  };
}

export function canonicalToAnthropicMessage(canonical: CanonicalChatResponse): JsonObject {
  const choice = canonical.choices[0];
  const message = toOpenAIMessage(choice?.message ?? { role: 'assistant', content: null });
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content: openAIMessageToAnthropicContent(message),
    model: canonical.model,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: canonical.usage ? {
      input_tokens: canonical.usage.prompt_tokens ?? 0,
      output_tokens: canonical.usage.completion_tokens ?? 0,
    } : undefined,
  };
}

function normalizeChoice(choice: unknown): CanonicalChoice {
  if (!isObject(choice)) return { index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop', logprobs: null };
  const messageRaw = isObject(choice.message) ? choice.message : {};
  const toolCalls = normalizeOpenAIToolCalls(messageRaw.tool_calls);
  const message: CanonicalAssistantMessage = {
    role: 'assistant',
    content: typeof messageRaw.content === 'string' ? messageRaw.content : null,
  };
  if (toolCalls) message.tool_calls = toolCalls as CanonicalToolCall[];
  return {
    index: typeof choice.index === 'number' ? choice.index : 0,
    message,
    finish_reason: normalizeFinishReason(choice.finish_reason),
    logprobs: choice.logprobs ?? null,
  };
}

function normalizeFinishReason(value: unknown): CanonicalChoice['finish_reason'] {
  if (value === null || value === undefined) return null;
  if (value === 'function_call') return 'tool_calls';
  if (value === 'stop' || value === 'length' || value === 'tool_calls') return value;
  if (String(value).includes('tool')) return 'tool_calls';
  if (String(value).includes('length') || String(value).includes('max_tokens')) return 'length';
  return 'stop';
}

function toOpenAIMessage(message: CanonicalAssistantMessage): JsonObject {
  const out: JsonObject = { role: 'assistant', content: message.content };
  if (message.tool_calls) out.tool_calls = message.tool_calls;
  if (out.annotations === undefined) out.annotations = [];
  if (out.refusal === undefined) out.refusal = null;
  return out;
}

function mapStopReason(reason: CanonicalChoice['finish_reason']): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
