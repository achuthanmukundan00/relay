import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { anthropicMessagesRequestToCanonical } from '../src/internal/anthropic-messages.ts';
import { canonicalToUpstreamChatRequest, openAIChatRequestToCanonical } from '../src/internal/openai-chat.ts';
import { responsesRequestToCanonical } from '../src/internal/openai-responses.ts';
import { applySamplingDefaults } from '../src/internal/sampling.ts';
import { canonicalToAnthropicMessage, canonicalToOpenAIChatCompletion, canonicalToOpenAIResponse, upstreamChatCompletionToCanonical } from '../src/internal/response.ts';

test('OpenAI chat canonical conversion preserves normalized upstream shape', () => {
  const config = testConfig();
  const input = {
    model: 'llama',
    max_completion_tokens: 99,
    messages: [{ role: 'developer', content: 'Rules' }, { role: 'user', content: 'Hi' }],
    functions: [{ name: 'lookup', parameters: { type: 'object' } }],
    function_call: { name: 'lookup' },
    response_format: { type: 'json_object' },
    stream: true,
    store: false,
  };

  const canonical = openAIChatRequestToCanonical(input, config);
  const upstream = canonicalToUpstreamChatRequest(canonical);

  assert.equal(upstream.max_tokens, 99);
  assert.deepEqual(upstream.messages[0], { role: 'system', content: 'Rules' });
  assert.equal(upstream.tools[0].function.name, 'lookup');
  assert.deepEqual(upstream.tool_choice, { type: 'function', function: { name: 'lookup' } });
  assert.deepEqual(upstream.response_format, { type: 'json_object' });
});

test('Responses canonical conversion preserves mapped chat semantics', () => {
  const config = testConfig();
  const canonical = responsesRequestToCanonical({
    model: 'llama',
    instructions: 'Be concise',
    input: 'Hello',
    max_output_tokens: 12,
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'lookup' },
  }, config);
  const upstream = canonicalToUpstreamChatRequest(canonical);

  assert.equal(upstream.max_tokens, 12);
  assert.deepEqual(upstream.messages, [
    { role: 'system', content: 'Be concise' },
    { role: 'user', content: 'Hello' },
  ]);
  assert.equal(upstream.tools[0].function.name, 'lookup');
});

test('Anthropic canonical conversion preserves mapped chat semantics', () => {
  const config = testConfig();
  const canonical = anthropicMessagesRequestToCanonical({
    model: 'llama',
    max_tokens: 32,
    system: [{ type: 'text', text: 'Rules' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    stop_sequences: ['</stop>'],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'lookup' },
  }, config);
  const upstream = canonicalToUpstreamChatRequest(canonical);

  assert.equal(upstream.max_tokens, 32);
  assert.deepEqual(upstream.messages[0], { role: 'system', content: 'Rules' });
  assert.deepEqual(upstream.stop, ['</stop>']);
  assert.equal(upstream.tools[0].function.name, 'lookup');
  assert.equal(upstream.tool_choice.function.name, 'lookup');
});

test('sampling defaults are centralized and only fill missing values', () => {
  const target: Record<string, unknown> = { temperature: 0.8 };
  applySamplingDefaults(target, { temperature: 0.2, top_p: 0.9 });
  assert.equal(target.temperature, 0.8);
  assert.equal(target.top_p, 0.9);
});

test('canonical response model maps to OpenAI chat, Responses, and Anthropic shapes', () => {
  const upstream = {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 10,
    model: 'llama',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'hi',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"relay"}' } }],
      },
      finish_reason: 'tool_calls',
      logprobs: null,
    }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };

  const canonical = upstreamChatCompletionToCanonical(upstream, 'llama');
  const chat = canonicalToOpenAIChatCompletion(canonical, { source: 'test' });
  const response = canonicalToOpenAIResponse(canonical, { metadata: { source: 'test' } });
  const anthropic = canonicalToAnthropicMessage(canonical);

  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'lookup');
  assert.equal(response.output[0].content[0].type, 'output_text');
  assert.equal(response.output[0].content[1].type, 'function_call');
  assert.equal(anthropic.content[1].type, 'tool_use');
});

function testConfig(): AppConfig {
  return {
    port: 8080,
    host: '127.0.0.1',
    upstreamBaseUrl: 'http://127.0.0.1:1',
    samplingDefaults: { temperature: 0.2 },
    requestTimeoutMs: 1_000,
    logLevel: 'silent',
    completionTtlMs: 3_600_000,
    maxRequestBodyBytes: 1_048_576,
    probeOnStartup: true,
    strictStartup: false,
    probeTimeoutMs: 3_000,
    unknownFieldPolicy: 'pass_through',
    strictCompat: false,
    warnOnStrippedFields: true,
    modelProfile: 'generic',
    reasoningMode: 'off',
    toolMode: 'auto',
    observabilityEnabled: true,
    logPrompts: false,
    requestHistoryLimit: 100,
    upstreamVisionOk: true,
  };
}
