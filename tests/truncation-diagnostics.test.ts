import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: any) => void;

test('large OpenAI payload keeps END marker through inbound parse and upstream forward', async () => {
  await withUpstream(async (upstream) => {
    const marker = bigMarkerPayload();
    let forwardedBody: any;
    upstream.handler = (_req, res, body) => {
      forwardedBody = body;
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };
    const app = createApp(testConfig(upstream.url));
    const response = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'llama', messages: [{ role: 'user', content: marker }] },
    });
    assert.equal(response.status, 200);
    assert.equal(forwardedBody.messages[0].content.includes('END_TRUNCATION_MARKER'), true);
    assert.equal(forwardedBody.messages[0].content.includes('START_TRUNCATION_MARKER'), true);
  });
});

test('large Anthropic tool_result keeps END marker through normalization and upstream forward', async () => {
  await withUpstream(async (upstream) => {
    const marker = bigMarkerPayload();
    let forwardedBody: any;
    upstream.handler = (_req, res, body) => {
      forwardedBody = body;
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };
    const app = createApp(testConfig(upstream.url));
    const response = await app.fetch('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: {
        model: 'llama',
        max_tokens: 8,
        messages: [{
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_test', content: marker },
          ],
        }],
      },
    });
    assert.equal(response.status, 200);
    assert.equal(forwardedBody.messages[0].role, 'tool');
    assert.equal(forwardedBody.messages[0].content.includes('END_TRUNCATION_MARKER'), true);
  });
});

test('streaming OpenAI path preserves END marker and emits done', async () => {
  await withUpstream(async (upstream) => {
    let forwardedBody: any;
    upstream.handler = (_req, res, body) => {
      forwardedBody = body;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n');
    };
    const marker = bigMarkerPayload();
    const app = createApp(testConfig(upstream.url));
    const response = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { model: 'llama', stream: true, messages: [{ role: 'user', content: marker }] },
    });
    const text = await response.text();
    assert.equal(forwardedBody.messages[0].content.includes('END_TRUNCATION_MARKER'), true);
    assert.match(text, /data: \[DONE\]/);
  });
});

function bigMarkerPayload(): string {
  return `START_TRUNCATION_MARKER\n${'ABCDE12345'.repeat(20_000)}\nEND_TRUNCATION_MARKER`;
}

function chatCompletion(model: string, content: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function testConfig(upstreamBaseUrl: string): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    upstreamBaseUrl,
    samplingDefaults: {},
    requestTimeoutMs: 10_000,
    logLevel: 'silent',
    completionTtlMs: 3_600_000,
    maxRequestBodyBytes: 3_000_000,
    probeOnStartup: false,
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

async function withUpstream(run: (upstream: { url: string; handler: Handler }) => Promise<void>) {
  const upstream = {
    url: '',
    handler: (_req: IncomingMessage, _res: ServerResponse, _body: any) => {
      throw new Error('upstream handler not set');
    },
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const parsed = text ? JSON.parse(text) : undefined;
    await upstream.handler(req, res, parsed);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected server address');
  upstream.url = `http://127.0.0.1:${address.port}`;
  try {
    await run(upstream);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}
