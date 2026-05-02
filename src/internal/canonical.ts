export type CanonicalProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages';

export type CanonicalContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: unknown }
  | { type: 'other'; value: unknown };

export type CanonicalMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | CanonicalContentPart[];
  tool_call_id?: string;
  tool_calls?: CanonicalToolCall[];
  name?: string;
};

export type CanonicalToolDefinition = Record<string, unknown>;
export type CanonicalToolChoice = unknown;

export type CanonicalToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type CanonicalSamplingOptions = {
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  n?: number;
  top_k?: number;
};

export type CanonicalResponseFormat = unknown;

export type CanonicalMetadata = {
  stripped_fields?: string[];
  warnings?: string[];
  unknown_fields?: string[];
};

export type CanonicalChatRequest = {
  source: CanonicalProtocol;
  model?: string;
  messages: CanonicalMessage[];
  tools?: CanonicalToolDefinition[];
  tool_choice?: CanonicalToolChoice;
  response_format?: CanonicalResponseFormat;
  sampling: CanonicalSamplingOptions;
  max_tokens?: number;
  stream?: boolean;
  store?: boolean;
  metadata?: Record<string, unknown>;
  extras: Record<string, unknown>;
  canonical_metadata?: CanonicalMetadata;
};

export type CanonicalFinishReason = 'stop' | 'length' | 'tool_calls' | null;

export type CanonicalChoice = {
  index: number;
  message: CanonicalAssistantMessage;
  finish_reason: CanonicalFinishReason;
  logprobs: unknown;
};

export type CanonicalAssistantMessage = {
  role: 'assistant';
  content: string | null;
  tool_calls?: CanonicalToolCall[];
};

export type CanonicalUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type CanonicalChatResponse = {
  id: string;
  object: 'chat.completion';
  created: number;
  model?: string;
  choices: CanonicalChoice[];
  usage?: CanonicalUsage;
  system_fingerprint?: unknown;
};

export type CanonicalStreamEvent =
  | { type: 'message_start'; data: Record<string, unknown> }
  | { type: 'text_delta'; data: Record<string, unknown> }
  | { type: 'tool_call_start'; data: Record<string, unknown> }
  | { type: 'tool_call_delta'; data: Record<string, unknown> }
  | { type: 'message_delta'; data: Record<string, unknown> }
  | { type: 'message_stop'; data: Record<string, unknown> }
  | { type: 'error'; data: Record<string, unknown> };
