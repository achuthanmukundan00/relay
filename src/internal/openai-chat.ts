import type { AppConfig } from '../config.ts';
import { missingRequiredFieldError } from '../errors.ts';
import { normalizeMessages } from '../normalize/messages.ts';
import { normalizeTools } from '../normalize/tools.ts';
import { samplingDefaultsFor } from '../profile.ts';
import { normalizeOpenAIResponseFormat } from '../openai/response-format.ts';
import { applySamplingDefaults } from './sampling.ts';
import type { CanonicalChatRequest, CanonicalMessage } from './canonical.ts';

type JsonObject = Record<string, any>;

export function openAIChatRequestToCanonical(input: JsonObject, config: AppConfig): CanonicalChatRequest {
  if (input.messages === undefined) throw missingRequiredFieldError('messages');

  const body: JsonObject = { ...input };
  if (body.max_tokens === undefined && input.max_completion_tokens !== undefined) body.max_tokens = input.max_completion_tokens;
  delete body.max_completion_tokens;

  applySamplingDefaults(body, samplingDefaultsFor(config));
  body.messages = normalizeMessages(body.messages, config);
  normalizeTools(body);
  normalizeOpenAIResponseFormat(body, config);

  const {
    model,
    messages,
    tools,
    tool_choice,
    response_format,
    max_tokens,
    stream,
    store,
    metadata,
    temperature,
    top_p,
    frequency_penalty,
    presence_penalty,
    seed,
    n,
    top_k,
    ...extras
  } = body;

  return {
    source: 'openai_chat',
    model,
    messages: (messages as JsonObject[]).map(toCanonicalMessage),
    tools,
    tool_choice,
    response_format,
    sampling: { temperature, top_p, frequency_penalty, presence_penalty, seed, n, top_k },
    max_tokens,
    stream,
    store,
    metadata,
    extras,
  };
}

export function canonicalToUpstreamChatRequest(canonical: CanonicalChatRequest): JsonObject {
  const out: JsonObject = {
    ...canonical.extras,
    model: canonical.model,
    messages: canonical.messages.map(fromCanonicalMessage),
  };
  if (canonical.tools !== undefined) out.tools = canonical.tools;
  if (canonical.tool_choice !== undefined) out.tool_choice = canonical.tool_choice;
  if (canonical.response_format !== undefined) out.response_format = canonical.response_format;
  if (canonical.max_tokens !== undefined) out.max_tokens = canonical.max_tokens;
  if (canonical.stream !== undefined) out.stream = canonical.stream;
  if (canonical.store !== undefined) out.store = canonical.store;
  if (canonical.metadata !== undefined) out.metadata = canonical.metadata;
  for (const [key, value] of Object.entries(canonical.sampling)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function toCanonicalMessage(message: JsonObject): CanonicalMessage {
  return {
    role: message.role,
    content: message.content,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls,
    name: message.name,
  };
}

function fromCanonicalMessage(message: CanonicalMessage): JsonObject {
  const out: JsonObject = { role: message.role, content: message.content };
  if (message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id;
  if (message.tool_calls !== undefined) out.tool_calls = message.tool_calls;
  if (message.name !== undefined) out.name = message.name;
  return out;
}
