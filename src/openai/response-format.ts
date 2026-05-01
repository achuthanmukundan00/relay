import type { AppConfig } from '../config.ts';
import { GatewayError, invalidRequestError, unsupportedCapabilityError } from '../errors.ts';

type JsonObject = Record<string, any>;

export function normalizeOpenAIResponseFormat(body: JsonObject, config: AppConfig): void {
  if (body.response_format === undefined) return;
  if (!isObject(body.response_format) || typeof body.response_format.type !== 'string') {
    throw new GatewayError(400, 'response_format.type is required', 'invalid_request_error', 'invalid_request');
  }
  if (body.response_format.type === 'text' || body.response_format.type === 'json_object') return;
  if (body.response_format.type === 'json_schema') {
    if (config.strictCompat) {
      throw unsupportedCapabilityError('response_format json_schema support is unknown for this upstream');
    }
    return;
  }
  throw invalidRequestError('response_format.type is not supported', 'unsupported_parameter', 'response_format');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
