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
  }
  validateContentParts(message.content, config);
  return message;
}

function validateContentParts(content: unknown, config: AppConfig) {
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!isObject(part)) continue;
    if (part.type === 'text') continue;
    if (part.type === 'refusal') {
      throw new GatewayError(400, 'refusal content parts cannot be sent upstream');
    }
    if (part.type === 'image_url' && config.upstreamVisionOk) continue;
    if (part.type === 'image_url') {
      throw new GatewayError(400, 'image_url content parts are not supported by this upstream', 'invalid_request_error', 'unsupported_modality');
    }
    if (part.type === 'input_audio' || part.type === 'file') {
      throw new GatewayError(400, `${part.type} content parts are not supported`, 'invalid_request_error', 'unsupported_modality');
    }
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
