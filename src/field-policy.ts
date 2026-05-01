import type { AppConfig } from './config.ts';
import { unsupportedCapabilityError, unsupportedParameterError } from './errors.ts';

type JsonObject = Record<string, any>;

export type FieldPolicyAction = 'map' | 'pass_through' | 'strip' | 'reject';
export type ProtocolName = 'openai_chat' | 'openai_responses' | 'anthropic_messages';

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
]);

const protocolPolicies: Record<ProtocolName, Record<string, FieldPolicyAction>> = {
  openai_chat: entries([
    'model', 'messages', 'temperature', 'top_p', 'max_tokens', 'stream', 'stream_options', 'stop',
    'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'frequency_penalty',
    'presence_penalty', 'seed', 'n', 'logprobs', 'top_logprobs', 'metadata', 'user',
    'reasoning_effort', 'verbosity', 'functions', 'function_call', 'max_completion_tokens', 'store',
  ], 'map'),
  openai_responses: entries([
    'model', 'instructions', 'input', 'previous_response_id', 'store', 'metadata', 'temperature',
    'top_p', 'max_output_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format',
    'stream',
  ], 'map'),
  anthropic_messages: {
    ...entries([
      'model', 'max_tokens', 'messages', 'system', 'temperature', 'top_p', 'top_k', 'stop_sequences',
      'stream', 'tools', 'tool_choice', 'metadata',
    ], 'map'),
    thinking: 'strip',
  },
};

export function applyFieldPolicy(protocol: ProtocolName, input: JsonObject, config: AppConfig): FieldPolicyResult {
  const policy = protocolPolicies[protocol];
  const body: JsonObject = {};
  const strippedFields: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    const action = actionForField(policy[key], key, config);
    if (action === 'map' || action === 'pass_through') {
      body[key] = value;
      continue;
    }
    if (action === 'strip') {
      strippedFields.push(key);
      continue;
    }
    if (hostedOnlyFields.has(key)) {
      throw unsupportedCapabilityError(`${key} is not supported by this local llama.cpp backend`);
    }
    throw unsupportedParameterError(key);
  }

  return { body, strippedFields };
}

export function withFieldWarning(response: Response, strippedFields: string[], config: AppConfig): Response {
  if (config.warnOnStrippedFields !== false && strippedFields.length > 0) {
    response.headers.set('x-relay-warning', 'stripped_unsupported_fields');
  }
  return response;
}

function actionForField(knownAction: FieldPolicyAction | undefined, key: string, config: AppConfig): FieldPolicyAction {
  if (knownAction) return knownAction;
  if (hostedOnlyFields.has(key)) return config.strictCompat ? 'reject' : 'strip';
  if (config.unknownFieldPolicy === 'strip') return 'strip';
  if (config.unknownFieldPolicy === 'reject') return 'reject';
  return 'pass_through';
}

function entries(keys: string[], action: FieldPolicyAction): Record<string, FieldPolicyAction> {
  return Object.fromEntries(keys.map((key) => [key, action]));
}
