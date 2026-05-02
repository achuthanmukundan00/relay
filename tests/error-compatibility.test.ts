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
  const badJsonBody = await badJson.json();
  assert.equal(badJsonBody.type, 'error');
  assert.equal(badJsonBody.error.type, 'invalid_request_error');

  const unsupported = await app.fetch('/v1/messages');
  assert.equal(unsupported.status, 404);
  const unsupportedBody = await unsupported.json();
  assert.equal(unsupportedBody.type, 'error');
  assert.equal(unsupportedBody.error.type, 'not_found_error');
});

test('known hosted OpenAI endpoints return deterministic unsupported endpoint errors', async () => {
  const app = createApp(testConfig('http://127.0.0.1:9'));

  const response = await app.fetch('/v1/audio/transcriptions', { method: 'POST', body: {} });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-relay-request-id') !== null, true);
  const body = await response.json();
  assert.equal(body.error.type, 'unsupported_endpoint');
  assert.equal(body.error.code, 'unsupported_endpoint');
  assert.match(body.error.message, /local llama\.cpp backend/);
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
  const body = JSON.parse(text);
  assert.equal(body.error.type, 'upstream_error');
  assert.equal(body.error.code, 'upstream_unavailable');
});

test('malformed JSON and missing required field use spec error codes', async () => {
  const app = createApp(testConfig('http://127.0.0.1:9'));

  const badJson = await app.fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.headers.get('x-relay-request-id') !== null, true);
  assert.deepEqual((await badJson.json()).error, {
    message: 'Invalid JSON body',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_json',
  });

  const missingMessages = await app.fetch('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'llama' },
  });
  assert.equal(missingMessages.status, 400);
  assert.deepEqual((await missingMessages.json()).error, {
    message: 'messages is required',
    type: 'invalid_request_error',
    param: 'messages',
    code: 'missing_required_field',
  });
});

test('oversized requests use the spec request_too_large code', async () => {
  const app = createApp({
    ...testConfig('http://127.0.0.1:9'),
    port: 18_000 + Math.floor(Math.random() * 1_000),
    maxRequestBodyBytes: 64,
  });
  const server = await app.listen();
  try {
    const oversized = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama',
        messages: [{ role: 'user', content: 'this body is intentionally too large for the configured limit' }],
      }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'request_too_large');
  } finally {
    await server.close();
  }
});

test('internal bugs return sanitized 500 OpenAI-shaped errors', async () => {
  const response = errorResponse(new Error('exploded with stack details'));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(text, /exploded|stack/i);
  assert.equal(JSON.parse(text).error.type, 'internal_error');
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
    probeOnStartup: true,
    strictStartup: false,
    probeTimeoutMs: 3_000,
    unknownFieldPolicy: 'pass_through',
    strictCompat: false,
    warnOnStrippedFields: true,
  };
}
