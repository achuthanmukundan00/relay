import { GatewayError } from '../errors.ts';
import type { AppConfig } from '../config.ts';

type JsonObject = Record<string, any>;

export function normalizeMessages(messages: unknown, config: AppConfig): JsonObject[] {
  if (!Array.isArray(messages)) {
    throw new GatewayError(400, 'messages must be an array');
  }
  return messages.map((raw, index) => normalizeMessage(raw, index, config));
}

function normalizeMessage(raw: unknown, index: number, config: AppConfig): JsonObject {
  if (!isObject(raw)) {
    throw new GatewayError(400, `messages[${index}] must be an object`);
  }
  const message: JsonObject = { ...raw };
  if (message.role === 'developer') {
    message.role = 'system';
  } else if (message.role === 'function') {
    message.role = 'tool';
    if (typeof message.tool_call_id !== 'string' && typeof message.name === 'string') {
      message.tool_call_id = message.name;
    }
  } else if (!['system', 'user', 'assistant', 'tool'].includes(String(message.role))) {
    throw new GatewayError(400, `messages[${index}].role is not supported`, 'invalid_request_error', 'unsupported_role');
  }
  message.content = normalizeContent(message.content, message, config);
  return message;
}

function normalizeContent(content: unknown, message: JsonObject, config: AppConfig): unknown {
  if (content === null && message.role === 'assistant' && Array.isArray(message.tool_calls)) return null;
  if (typeof content === 'string' || content === null || content === undefined) return content;
  if (!Array.isArray(content)) {
    throw new GatewayError(400, 'message content must be a string, null, or content part array');
  }
  const text: string[] = [];
  let hasPassthroughPart = false;
  for (const [index, part] of content.entries()) {
    if (!isObject(part) || typeof part.type !== 'string') {
      throw new GatewayError(400, `content part at index ${index} must be an object with a type`);
    }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') {
        throw new GatewayError(400, `text content part at index ${index} must include text`);
      }
      text.push(part.text);
      continue;
    }
    if (part.type === 'refusal') {
      throw new GatewayError(400, 'refusal content parts cannot be sent upstream');
    }
    if (part.type === 'image_url' && config.upstreamVisionOk) {
      hasPassthroughPart = true;
      continue;
    }
    if (part.type === 'image_url') {
      throw new GatewayError(400, 'image_url content parts are not supported by this upstream', 'invalid_request_error', 'unsupported_modality');
    }
    if (part.type === 'input_audio' || part.type === 'file') {
      throw new GatewayError(400, `${part.type} content parts are not supported`, 'invalid_request_error', 'unsupported_modality');
    }
    throw new GatewayError(400, `${part.type} content parts are not supported`, 'invalid_request_error', 'unsupported_modality');
  }
  return hasPassthroughPart ? content : text.join('\n');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
