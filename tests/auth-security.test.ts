import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { createApp } from '../src/server.ts';

test('default config binds to localhost unless HOST is explicit', async () => {
  const { loadConfig } = await import('../src/config.ts');

  assert.equal(loadConfig({}).host, '127.0.0.1');
  assert.equal(loadConfig({ HOST: '0.0.0.0' }).host, '0.0.0.0');
});

test('OpenAI auth accepts bearer and x-api-key and rejects incorrect keys', async () => {
  const app = createApp({ ...testConfig('http://127.0.0.1:9'), apiKey: 'secret' });

  const bad = await app.fetch('/v1/models', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error.type, 'authentication_error');

  const bearer = await app.fetch('/v1/models', { headers: { authorization: 'Bearer secret' } });
  assert.equal(bearer.status, 502);

  const xApiKey = await app.fetch('/v1/models', { headers: { 'x-api-key': 'secret' } });
  assert.equal(xApiKey.status, 502);
});

test('Anthropic auth returns Anthropic-shaped 401 for incorrect keys', async () => {
  const app = createApp({ ...testConfig('http://127.0.0.1:9'), apiKey: 'secret' });

  const response = await app.fetch('/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'wrong' },
    body: { model: 'llama', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
  });

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'authentication_error');
});

test('error logs include request ids without leaking API keys or prompts', async () => {
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const app = createApp(testConfig('http://127.0.0.1:9'));
    const response = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'x-request-id': 'req_test_123',
        authorization: 'Bearer super-secret-key',
      },
      body: {
        model: 'llama',
        messages: [{ role: 'user', content: 'private prompt text' }],
      },
    });

    assert.equal(response.status, 502);
    assert.equal(response.headers.get('x-request-id'), 'req_test_123');
    const logText = writes.join('');
    assert.match(logText, /"request_id":"req_test_123"/);
    assert.doesNotMatch(logText, /super-secret-key|private prompt text/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('logger redacts auth headers, CF access headers, cookies, and bearer tokens', () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const logger = createLogger('info');
    logger.info('diagnostic', {
      authorization: 'Bearer top-secret-token',
      'cf-access-client-id': 'client-id-value',
      'cf-access-client-secret': 'client-secret-value',
      cookie: 'session=very-secret',
      nested: {
        api_key: 'nested-secret',
        note: 'Authorization: Bearer still-secret',
      },
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const logText = writes.join('');
  assert.doesNotMatch(logText, /top-secret-token|client-id-value|client-secret-value|very-secret|nested-secret|still-secret/);
  assert.match(logText, /\[REDACTED\]/);
});

test('oversized HTTP request bodies are rejected before upstream handling', async () => {
  const app = createApp({
    ...testConfig('http://127.0.0.1:9'),
    port: await freePort(),
    maxRequestBodyBytes: 16,
    logLevel: 'silent',
  });
  const server = await app.listen();
  try {
    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_too_large',
      },
      body: JSON.stringify({ prompt: 'this request is too large' }),
    });

    assert.equal(response.status, 413);
    assert.equal(response.headers.get('x-request-id'), 'req_too_large');
    assert.equal((await response.json()).error.type, 'invalid_request_error');
  } finally {
    await server.close();
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected server address');
  const { port } = address;
  server.close();
  await once(server, 'close');
  return port;
}

function testConfig(upstreamBaseUrl: string): AppConfig {
  return {
    port: 8080,
    host: '127.0.0.1',
    upstreamBaseUrl,
    samplingDefaults: {},
    requestTimeoutMs: 50,
    logLevel: 'info',
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
  };
}
