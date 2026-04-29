import { hasValidApiKey } from '../auth.ts';
import type { AppConfig } from '../config.ts';
import { GatewayError, jsonResponse } from '../errors.ts';
import { encodeSSE, streamHeaders } from '../normalize/stream.ts';
import { normalizeAnthropicTools, openAIMessageToAnthropicContent } from '../normalize/tools.ts';
import { upstreamFetch, upstreamJson } from '../upstream/llama.ts';

type JsonObject = Record<string, any>;

export async function handleAnthropicMessages(config: AppConfig, request: Request): Promise<Response> {
  try {
    authorizeAnthropic(config, request);
    const body = await readJson(request);
    const chatRequest = anthropicRequestToChat(body);
    if (body.stream === true) return await streamAnthropicMessage(config, chatRequest);
    const chat = await upstreamJson(config, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatRequest),
    });
    return jsonResponse(chatCompletionToAnthropicMessage(chat, body.model));
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
    throw new GatewayError(400, 'Invalid JSON body');
  }
}

function anthropicRequestToChat(input: JsonObject): JsonObject {
  if (input.max_tokens === undefined) {
    throw new GatewayError(400, 'max_tokens is required');
  }
  const messages: JsonObject[] = [];
  const system = normalizeSystem(input.system);
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...normalizeAnthropicMessages(input.messages));

  const chat: JsonObject = {
    model: input.model,
    max_tokens: input.max_tokens,
    messages,
  };
  for (const key of ['temperature', 'top_p', 'metadata', 'stream']) {
    if (input[key] !== undefined) chat[key] = input[key];
  }
  if (input.stop_sequences !== undefined) chat.stop = input.stop_sequences;
  const tools = normalizeAnthropicTools(input.tools);
  if (tools) chat.tools = tools;
  const toolChoice = normalizeAnthropicToolChoice(input.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  // TODO: Map Anthropic thinking to model-specific reasoning controls when an
  // upstream supports it. For now it is accepted and intentionally not forwarded.
  return chat;
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

function normalizeAnthropicMessages(messages: unknown): JsonObject[] {
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
      out.push(...normalizeUserBlocks(message.content));
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

function normalizeUserBlocks(blocks: unknown[]): JsonObject[] {
  const out: JsonObject[] = [];
  let pendingText: string[] = [];
  const flushText = () => {
    if (pendingText.length > 0) {
      out.push({ role: 'user', content: pendingText.join('\n') });
      pendingText = [];
    }
  };
  for (const block of blocks) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      pendingText.push(block.text);
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
  if (!isObject(chat)) throw new GatewayError(502, 'Upstream returned invalid completion', 'api_error');
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
    throw new GatewayError(502, 'Upstream llama server is unavailable', 'api_error');
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const messageId = `msg_${crypto.randomUUID()}`;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(encodeSSE({ event: 'message_start', data: {
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', content: [], model: chatRequest.model },
      } })));
      let buffer = '';
      let textStarted = false;
      let toolStarted = false;
      let stopReason = 'end_turn';
      const reader = upstream.response.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          const dataLine = event.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const data = dataLine.slice('data: '.length);
          if (data === '[DONE]') continue;
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          const content = choice?.delta?.content;
          if (typeof content === 'string') {
            if (!textStarted) {
              textStarted = true;
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
            if (!toolStarted && toolCall.id && fn.name) {
              toolStarted = true;
              controller.enqueue(encoder.encode(encodeSSE({ event: 'content_block_start', data: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: toolCall.id, name: fn.name, input: {} },
              } })));
            }
            if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
              controller.enqueue(encoder.encode(encodeSSE({ event: 'content_block_delta', data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: fn.arguments },
              } })));
            }
          }
          if (choice?.finish_reason) stopReason = mapStopReason(choice.finish_reason);
        }
      }
      if (textStarted || toolStarted) {
        controller.enqueue(encoder.encode(encodeSSE({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } })));
      }
      controller.enqueue(encoder.encode(encodeSSE({ event: 'message_delta', data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {},
      } })));
      controller.enqueue(encoder.encode(encodeSSE({ event: 'message_stop', data: { type: 'message_stop' } })));
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

function anthropicErrorResponse(error: unknown): Response {
  if (error instanceof GatewayError) {
    return anthropicError(error.status, error.message, anthropicType(error.status, error.type));
  }
  return anthropicError(500, 'Internal gateway error', 'api_error');
}

function anthropicError(status: number, message: string, type: string): Response {
  return jsonResponse({ type: 'error', error: { type, message } }, status);
}

function anthropicType(status: number, type: string): string {
  if (status === 401) return 'authentication_error';
  if (status >= 500) return 'api_error';
  return type === 'authentication_error' ? type : 'invalid_request_error';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
