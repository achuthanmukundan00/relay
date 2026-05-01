import type { AppConfig } from './config.ts';
import { GatewayError } from './errors.ts';

type JsonObject = Record<string, any>;

export type FieldPolicyAction = 'map' | 'pass_through' | 'strip' | 'reject' | 'warn';

export type FieldPolicyResult = {
  body: JsonObject;
  strippedFields: string[];
};

const hostedOnlyFields = new Set([
  'web_search_options',
  'file_search',
  'computer_use',
  'code_interpreter',
  'service_tier',
  'background',
  'previous_response_id',
]);

export function applyOpenAIChatFieldPolicy(input: JsonObject, allowed: string[], config: AppConfig): FieldPolicyResult {
  const allowedSet = new Set(allowed);
  const body: JsonObject = {};
  const strippedFields: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (allowedSet.has(key)) {
      body[key] = value;
      continue;
    }
    const action = actionForField(key, config);
    if (action === 'pass_through' || action === 'warn') {
      body[key] = value;
    } else if (action === 'strip') {
      strippedFields.push(key);
    } else {
      throw new GatewayError(400, `${key} is not supported by this local llama.cpp backend`, 'invalid_request_error', 'unsupported_parameter');
    }
  }
  return { body, strippedFields };
}

function actionForField(key: string, config: AppConfig): FieldPolicyAction {
  if (hostedOnlyFields.has(key)) return config.strictCompat ? 'reject' : 'strip';
  if (config.unknownFieldPolicy === 'strip') return 'strip';
  if (config.unknownFieldPolicy === 'reject') return 'reject';
  return 'pass_through';
}
