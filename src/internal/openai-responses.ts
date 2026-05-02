import type { AppConfig } from '../config.ts';
import { invalidRequestError, unsupportedCapabilityError } from '../errors.ts';
import { normalizeMessages } from '../normalize/messages.ts';
import { normalizeTools } from '../normalize/tools.ts';
import { normalizeOpenAIResponseFormat } from '../openai/response-format.ts';
import { samplingDefaultsFor } from '../profile.ts';
import { applySamplingDefaults } from './sampling.ts';
import type { CanonicalChatRequest } from './canonical.ts';

type JsonObject = Record<string, any>;

export function responsesRequestToCanonical(input: JsonObject, config: AppConfig): CanonicalChatRequest {
  const messages: JsonObject[] = [];
  if (typeof input.instructions === 'string' && input.instructions.length > 0) {
    messages.push({ role: 'system', content: input.instructions });
  }
  if (typeof input.input === 'string') {
    messages.push({ role: 'user', content: input.input });
  } else if (Array.isArray(input.input)) {
    messages.push(...normalizeResponseInput(input.input, config));
  } else {
    throw invalidRequestError('input must be a string or message array');
  }

  const chat: JsonObject = { ...input, messages };
  if (input.max_output_tokens !== undefined) chat.max_tokens = input.max_output_tokens;
  delete chat.instructions;
  delete chat.input;
  delete chat.max_output_tokens;
  rejectHostedResponsesTools(chat.tools);
  applySamplingDefaults(chat, samplingDefaultsFor(config));
  normalizeTools(chat);
  normalizeOpenAIResponseFormat(chat, config);

  const {
    model,
    messages: normalized,
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
  } = chat;

  return {
    source: 'openai_responses',
    model,
    messages: normalized,
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

function normalizeResponseInput(input: unknown[], config: AppConfig): JsonObject[] {
  return normalizeMessages(input.map((message) => normalizeResponseInputMessage(message)), config);
}

function normalizeResponseInputMessage(message: unknown): unknown {
  if (!isObject(message) || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (!isObject(part) || typeof part.type !== 'string') return part;
      if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
        return { type: 'text', text: part.text };
      }
      if (part.type === 'input_image' && typeof part.image_url === 'string') {
        return { type: 'image_url', image_url: { url: part.image_url } };
      }
      return part;
    }),
  };
}

function rejectHostedResponsesTools(tools: unknown): void {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (isObject(tool) && typeof tool.type === 'string' && tool.type !== 'function') {
      throw unsupportedCapabilityError(`${tool.type} tools are not supported by this local llama.cpp backend`);
    }
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
