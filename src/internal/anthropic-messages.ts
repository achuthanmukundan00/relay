import type { AppConfig } from '../config.ts';
import { GatewayError, missingRequiredFieldError, unsupportedCapabilityError } from '../errors.ts';
import { normalizeAnthropicTools } from '../normalize/tools.ts';
import { samplingDefaultsFor } from '../profile.ts';
import { applySamplingDefaults } from './sampling.ts';
import type { CanonicalChatRequest } from './canonical.ts';

type JsonObject = Record<string, any>;

export function anthropicMessagesRequestToCanonical(input: JsonObject, config: AppConfig): CanonicalChatRequest {
  if (input.max_tokens === undefined) throw missingRequiredFieldError('max_tokens');

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

  const {
    model,
    messages: normalized,
    tools: normalizedTools,
    tool_choice,
    response_format,
    max_tokens,
    stream,
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    seed,
    n,
    top_k,
    ...extras
  } = chat;

  return {
    source: 'anthropic_messages',
    model,
    messages: normalized,
    tools: normalizedTools,
    tool_choice,
    response_format,
    sampling: { temperature, top_p, frequency_penalty, presence_penalty, seed, n, top_k },
    max_tokens,
    stream,
    extras,
  };
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
      out.push({ role: 'user', content: pendingParts.some((part) => part.type !== 'text') ? pendingParts : pendingText.join('\n') });
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
  if (!isObject(toolChoice) || typeof toolChoice.type !== 'string') throw new GatewayError(400, 'tool_choice must be an object');
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  throw new GatewayError(400, 'Unsupported tool_choice');
}

function isImageBlock(value: unknown): value is { source: { type: string; media_type?: string; data?: string } } & JsonObject {
  return isObject(value) && value.type === 'image' && isObject(value.source) && value.source.type === 'base64';
}

function normalizeImageBlock(block: { source: { media_type?: string; data?: string } }, config: AppConfig): JsonObject {
  if (!config.upstreamVisionOk) {
    throw unsupportedCapabilityError('Image content blocks are not supported by this upstream');
  }
  const mediaType = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png';
  const data = typeof block.source.data === 'string' ? block.source.data : '';
  return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
