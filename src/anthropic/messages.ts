import { hasValidApiKey } from '../auth.ts';
import type { AppConfig } from '../config.ts';
import { anthropicError, GatewayError, invalidJsonError, jsonResponse, missingRequiredFieldError, unsupportedCapabilityError, upstreamError } from '../errors.ts';
import { applyFieldPolicy, withFieldWarning } from '../field-policy.ts';
import { encodeSSE, parseSSEJson, parseSSEStream, streamHeaders } from '../normalize/stream.ts';
import { normalizeAnthropicTools, openAIMessageToAnthropicContent } from '../normalize/tools.ts';
import { samplingDefaultsFor } from '../profile.ts';
import { upstreamFetch, upstreamHttpError, upstreamJson } from '../upstream/llama.ts';

type JsonObject = Record<string, any>;

export async function handleAnthropicMessages(config: AppConfig, request: Request): Promise<Response> {
  try {
    authorizeAnthropic(config, request);
    const rawBody = await readJson(request);
    const { body, strippedFields } = applyFieldPolicy('anthropic_messages', rawBody, config);
    const chatRequest = anthropicRequestToChat(body, config);
    if (body.stream === true) return withFieldWarning(await streamAnthropicMessage(config, chatRequest), strippedFields, config);
    const chat = await upstreamJson(config, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatRequest),
    });
    return withFieldWarning(jsonResponse(chatCompletionToAnthropicMessage(chat, body.model)), strippedFields, config);
  } catch (error) {
    return anthropicErrorResponse(error);
  }
}

export async function handleAnthropicCountTokens(config: AppConfig, request: Request): Promise<Response> {
  try {
    authorizeAnthropic(config, request);
    const rawBody = await readJson(request);
    const { body } = applyFieldPolicy('anthropic_messages', rawBody, config);
    const tokenizerRequest = anthropicCountTokensRequest(body, config);
    const upstream = await upstreamFetch(config, '/tokenize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(tokenizerRequest),
    });
    if (upstream.response.status === 404 || upstream.response.status === 501) {
      throw unsupportedCapabilityError('Token counting is not supported by this local llama.cpp backend');
    }
    if (!upstream.response.ok) {
      throw await upstreamHttpError(upstream.response);
    }
    const payload = await upstream.response.json().catch(() => {
      throw upstreamError('bad_response', 'Upstream returned invalid token count JSON');
    });
    return jsonResponse({ input_tokens: extractTokenCount(payload) });
  } catch (error) {
    return anthropicErrorResponse(error);
  }
}

function authorizeAnthropic(config: AppConfig, request: Request): void {
  if (!config.apiKey) return;
  const xKey = request.headers.get('x-api-key');
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (hasValidApiKey(config.apiKey, xKey, bearer)) return;
  throw new GatewayError(401, 'Unauthorized', 'authentication_error');
}

async function readJson(request: Request): Promise<JsonObject> {
  try {
    const body = await request.json();
    if (!isObject(body)) throw new Error('not object');
    return body;
  } catch {
    throw invalidJsonError();
  }
}

function anthropicRequestToChat(input: JsonObject, config: AppConfig): JsonObject {
  if (input.max_tokens === undefined) {
    throw missingRequiredFieldError('max_tokens');
  }
  const messages: JsonObject[] = [];
  const system = normalizeSystem(input.system);
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...normalizeAnthropicMessages(input.messages, config));

  const chat: JsonObject = { ...input, messages };
  if (input.stop_sequences !== undefined) chat.stop = input.stop_sequences;
  const tools = normalizeAnthropicTools(input.tools);
  if (tools) chat.tools = tools;
  const toolChoice = normalizeAnthropicToolChoice(input.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  delete chat.system;
  delete chat.stop_sequences;
  applySamplingDefaults(chat, samplingDefaultsFor(config));
  // TODO: Map Anthropic thinking to model-specific reasoning controls when an
  // upstream supports it. For now it is accepted and intentionally not forwarded.
  return chat;
}

function applySamplingDefaults(body: JsonObject, defaults: AppConfig['samplingDefaults']): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (value !== undefined && body[key] === undefined) body[key] = value;
  }
}

function normalizeSystem(system: unknown): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((block, index) => {
      if (isObject(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
      throw new GatewayError(400, `Unsupported system content block at index ${index}`);
    }).join('\n');
  }
  throw new GatewayError(400, 'system must be a string or text block array');
}

function normalizeAnthropicMessages(messages: unknown, config: AppConfig): JsonObject[] {
  if (!Array.isArray(messages)) throw new GatewayError(400, 'messages must be an array');
  const out: JsonObject[] = [];
  for (const message of messages) {
    if (!isObject(message) || (message.role !== 'user' && message.role !== 'assistant')) {
      throw new GatewayError(400, 'messages must contain user or assistant roles');
    }
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) throw new GatewayError(400, 'message content must be a string or block array');
    if (message.role === 'assistant') {
      out.push(normalizeAssistantBlocks(message.content));
    } else {
      out.push(...normalizeUserBlocks(message.content, config));
    }
  }
  return out;
}

function normalizeAssistantBlocks(blocks: unknown[]): JsonObject {
  const text: string[] = [];
  const toolCalls: JsonObject[] = [];
  for (const block of blocks) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
    } else if (isObject(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(isObject(block.input) ? block.input : {}),
        },
      });
    } else {
      throw new GatewayError(400, 'Unsupported assistant content block');
    }
  }
  const message: JsonObject = { role: 'assistant', content: text.join('\n') || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

function normalizeUserBlocks(blocks: unknown[], config: AppConfig): JsonObject[] {
  const out: JsonObject[] = [];
  let pendingText: string[] = [];
  let pendingParts: JsonObject[] = [];
  const flushText = () => {
    if (pendingParts.length > 0) {
      out.push({
        role: 'user',
        content: pendingParts.some((part) => part.type !== 'text') ? pendingParts : pendingText.join('\n'),
      });
      pendingText = [];
      pendingParts = [];
    }
  };
  for (const block of blocks) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      pendingText.push(block.text);
      pendingParts.push({ type: 'text', text: block.text });
    } else if (isImageBlock(block)) {
      pendingParts.push(normalizeImageBlock(block, config));
    } else if (isObject(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      flushText();
      out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: normalizeToolResultContent(block.content) });
    } else {
      throw new GatewayError(400, 'Unsupported user content block');
    }
  }
  flushText();
  return out;
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block, index) => {
      if (isObject(block) && block.type === 'text' && typeof block.text === 'string') return block.text;
      throw new GatewayError(400, `Unsupported tool_result content block at index ${index}`);
    }).join('\n');
  }
  if (isObject(content)) return JSON.stringify(content);
  if (content === undefined || content === null) return '';
  throw new GatewayError(400, 'Unsupported tool_result content');
}

function normalizeAnthropicToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === undefined) return undefined;
  if (!isObject(toolChoice) || typeof toolChoice.type !== 'string') {
    throw new GatewayError(400, 'tool_choice must be an object');
  }
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  throw new GatewayError(400, 'Unsupported tool_choice');
}

function chatCompletionToAnthropicMessage(chat: unknown, requestedModel: unknown): JsonObject {
  if (!isObject(chat)) throw upstreamError('bad_response', 'Upstream returned invalid completion');
  const choice = Array.isArray(chat.choices) ? chat.choices[0] : undefined;
  const message = isObject(choice?.message) ? choice.message : {};
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content: openAIMessageToAnthropicContent(message),
    model: typeof chat.model === 'string' ? chat.model : requestedModel,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: isObject(chat.usage) ? {
      input_tokens: chat.usage.prompt_tokens ?? 0,
      output_tokens: chat.usage.completion_tokens ?? 0,
    } : undefined,
  };
}

async function streamAnthropicMessage(config: AppConfig, chatRequest: JsonObject): Promise<Response> {
  const upstream = await upstreamFetch(config, '/v1/chat/completions', {
    method: 'POST',
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify(chatRequest),
  });
  if (!upstream.response.ok || !upstream.response.body) {
    throw upstream.response.body ? await upstreamHttpError(upstream.response) : upstreamError('bad_response', 'Upstream returned an empty stream');
  }
  const encoder = new TextEncoder();
  const messageId = `msg_${crypto.randomUUID()}`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(encodeSSE({ event: 'message_start', data: {
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', content: [], model: chatRequest.model },
      } })));
      let textStarted = false;
      const startedBlocks = new Set<number>();
      let stopReason = 'end_turn';
      let failed = false;
      try {
        for await (const frame of parseSSEStream(upstream.response.body!)) {
          if (frame.data === '[DONE]') break;
          const chunk = parseSSEJson(frame);
          const choice = chunk.choices?.[0];
          const content = choice?.delta?.content;
          if (typeof content === 'string') {
            if (!textStarted) {
              textStarted = true;
              startedBlocks.add(0);
              controller.enqueue(encoder.encode(encodeSSE({ event: 'content_block_start', data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              } })));
            }
            controller.enqueue(encoder.encode(encodeSSE({ event: 'content_block_delta', data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: content },
            } })));
          }
          for (const toolCall of choice?.delta?.tool_calls ?? []) {
            const fn = toolCall.function ?? {};
            const blockIndex = (textStarted ? 1 : 0) + (typeof toolCall.index === 'number' ? toolCall.index : 0);
            if (!startedBlocks.has(blockIndex) && toolCall.id && fn.name) {
              startedBlocks.add(blockIndex);
              controller.enqueue(encoder.encode(encodeSSE({ event: 'content_block_start', data: {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'tool_use', id: toolCall.id, name: fn.name, input: {} },
              } })));
            }
            if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
              controller.enqueue(encoder.encode(encodeSSE({ event: 'content_block_delta', data: {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: fn.arguments },
              } })));
            }
          }
          if (choice?.finish_reason) stopReason = mapStopReason(choice.finish_reason);
        }
      } catch (error) {
        failed = true;
        controller.enqueue(encoder.encode(encodeSSE({
          event: 'error',
          data: {
            type: 'error',
            error: {
              type: 'api_error',
              message: error instanceof Error ? error.message : 'Upstream stream failed',
            },
          },
        })));
      }
      for (const index of [...startedBlocks].sort((a, b) => a - b)) {
        controller.enqueue(encoder.encode(encodeSSE({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })));
      }
      if (!failed) {
        controller.enqueue(encoder.encode(encodeSSE({ event: 'message_delta', data: {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {},
        } })));
        controller.enqueue(encoder.encode(encodeSSE({ event: 'message_stop', data: { type: 'message_stop' } })));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: streamHeaders() });
}

function mapStopReason(reason: unknown): string {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'content_filter') return 'stop_sequence';
  return 'end_turn';
}

function anthropicCountTokensRequest(input: JsonObject, config: AppConfig): JsonObject {
  if (input.messages === undefined) {
    throw missingRequiredFieldError('messages');
  }
  const parts: string[] = [];
  const system = normalizeSystem(input.system);
  if (system) parts.push(system);
  for (const message of normalizeAnthropicMessages(input.messages, config)) {
    if (typeof message.content === 'string') {
      parts.push(message.content);
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isObject(part) && part.type === 'text' && typeof part.text === 'string') {
          parts.push(part.text);
          continue;
        }
        throw unsupportedCapabilityError('Token counting for multimodal content is not supported by this local llama.cpp backend');
      }
    }
  }
  return { content: parts.join('\n') };
}

function extractTokenCount(payload: unknown): number {
  if (isObject(payload) && typeof payload.count === 'number') return payload.count;
  if (isObject(payload) && typeof payload.token_count === 'number') return payload.token_count;
  if (isObject(payload) && typeof payload.n_tokens === 'number') return payload.n_tokens;
  if (isObject(payload) && Array.isArray(payload.tokens)) return payload.tokens.length;
  throw upstreamError('bad_response', 'Upstream returned an unsupported token count shape');
}

function isImageBlock(block: unknown): block is JsonObject {
  return isObject(block) && block.type === 'image';
}

function normalizeImageBlock(block: JsonObject, config: AppConfig): JsonObject {
  if (!config.upstreamVisionOk) {
    throw unsupportedCapabilityError('Image content blocks are not supported by this local llama.cpp backend');
  }
  const source = isObject(block.source) ? block.source : {};
  if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
    return {
      type: 'image_url',
      image_url: { url: `data:${source.media_type};base64,${source.data}` },
    };
  }
  throw new GatewayError(400, 'Unsupported image content block', 'invalid_request_error', 'unsupported_parameter');
}

function anthropicErrorResponse(error: unknown): Response {
  if (error instanceof GatewayError) {
    return anthropicError(error.status, error.message, anthropicType(error.status, error.type));
  }
  return anthropicError(500, 'Internal gateway error', 'api_error');
}

function anthropicType(status: number, type: string): string {
  if (status === 401) return 'authentication_error';
  if (status >= 500) return 'api_error';
  return type === 'authentication_error' ? type : 'invalid_request_error';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
