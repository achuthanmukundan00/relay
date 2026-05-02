import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const required = [
  'openai-chat-non-stream.json',
  'openai-chat-stream.json',
  'openai-completions-legacy.json',
  'openai-responses-non-stream.json',
  'openai-responses-stream.json',
  'anthropic-messages-non-stream.json',
  'anthropic-messages-stream.json',
  'embeddings.json',
  'rerank.json',
  'token-count.json',
];

test('baseline compatibility fixtures exist and are valid JSON', () => {
  for (const name of required) {
    const raw = readFileSync(`tests/fixtures/baseline/${name}`, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), `invalid JSON for ${name}`);
  }
});
