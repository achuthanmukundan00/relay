import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { errorResponse } from '../src/errors.ts';
import { createApp } from '../src/server.ts';

test('OpenAI endpoints return 401 OpenAI-shaped error when API key is configured', async () => {
  const app = createApp({ ...testConfig('http://127.0.0.1:9'), apiKey: 'secret' });

  const unauthorized = await app.fetch('/v1/models');
  assert.equal(unauthorized.status, 401);
  const body = await unauthorized.json();
  assert.equal(typeof body.error.message, 'string');
  assert.equal(body.error.type, 'authentication_error');

  const authorized = await app.fetch('/v1/models', { headers: { authorization: 'Bearer secret' } });
  assert.equal(authorized.status, 502);
});

test('Anthropic bad JSON and unsupported endpoint use provider-native shapes', async () => {
  const app = createApp(testConfig('http://127.0.0.1:9'));

  const badJson = await app.fetch('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).type, 'error');

  const unsupported = await app.fetch('/v1/messages');
  assert.equal(unsupported.status, 404);
  const unsupportedBody = await unsupported.json();
  assert.equal(unsupportedBody.type, 'error');
  assert.equal(unsupportedBody.error.type, 'not_found_error');
});

test('upstream connection refused maps to 502 without leaking stack traces', async () => {
  const app = createApp(testConfig('http://127.0.0.1:9'));
  const response = await app.fetch('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'llama', messages: [{ role: 'user', content: 'hello' }] },
  });

  assert.equal(response.status, 502);
  const text = await response.text();
  assert.doesNotMatch(text, /stack|ECONNREFUSED|TypeError/i);
  assert.equal(JSON.parse(text).error.type, 'server_error');
});

test('internal bugs return sanitized 500 OpenAI-shaped errors', async () => {
  const response = errorResponse(new Error('exploded with stack details'));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(text, /exploded|stack/i);
  assert.equal(JSON.parse(text).error.type, 'server_error');
});

function testConfig(upstreamBaseUrl: string): AppConfig {
  return {
    port: 8080,
    host: '127.0.0.1',
    upstreamBaseUrl,
    samplingDefaults: {},
    requestTimeoutMs: 50,
    logLevel: 'silent',
    completionTtlMs: 3_600_000,
    maxRequestBodyBytes: 1_048_576,
  };
}
