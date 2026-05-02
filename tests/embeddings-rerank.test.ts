import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

test('POST /v1/embeddings normalizes single-string and array responses', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (req, res, body) => {
      assert.equal(req.url, '/v1/embeddings');
      if (typeof (body as any).input === 'string') {
        sendJson(res, 200, {
          data: [{ embedding: [0.1, 0.2], index: 0 }],
          model: 'llama-embed',
          usage: { prompt_tokens: 3, total_tokens: 3 },
        });
        return;
      }
      sendJson(res, 200, {
        embeddings: [[0.3, 0.4], [0.5, 0.6]],
        model: 'llama-embed',
      });
    };
    const app = createApp(testConfig(upstream.url));

    const single = await app.fetch('/v1/embeddings', {
      method: 'POST',
      body: { model: 'local', input: 'embed me', encoding_format: 'float' },
    });
    assert.equal(single.status, 200);
    assert.deepEqual(await single.json(), {
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      model: 'llama-embed',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });

    const many = await app.fetch('/v1/embeddings', {
      method: 'POST',
      body: { model: 'local', input: ['a', 'b'] },
    });
    assert.equal(many.status, 200);
    const body = await many.json();
    assert.equal(body.data.length, 2);
    assert.deepEqual(body.data[1], { object: 'embedding', embedding: [0.5, 0.6], index: 1 });
  });
});

test('POST /v1/embeddings returns a clean unsupported capability error and validates input', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 404, { error: 'missing' });
    const app = createApp(testConfig(upstream.url));

    const unsupported = await app.fetch('/v1/embeddings', {
      method: 'POST',
      body: { model: 'local', input: 'embed me' },
    });
    assert.equal(unsupported.status, 400);
    const unsupportedBody = await unsupported.json();
    assert.equal(unsupportedBody.error.type, 'unsupported_capability');
    assert.equal(unsupportedBody.error.code, 'embeddings_unsupported');

    const invalid = await app.fetch('/v1/embeddings', {
      method: 'POST',
      body: { model: 'local', input: [1, 2, 3] },
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error.message, /string or array of strings/i);
  });
});

test('POST /v1/rerank and POST /rerank normalize response shapes', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (req, res, body) => {
      assert.match(req.url ?? '', /\/rerank$/);
      assert.equal((body as any).top_n, 1);
      sendJson(res, 200, {
        model: 'llama-rerank',
        data: [{ document_index: 0, score: 0.95 }],
      });
    };
    const app = createApp(testConfig(upstream.url));

    const request = {
      model: 'local',
      query: 'What is Relay?',
      documents: ['Relay is a local gateway.', 'Other'],
      top_k: 1,
      return_documents: true,
    };

    const v1 = await app.fetch('/v1/rerank', { method: 'POST', body: request });
    assert.equal(v1.status, 200);
    assert.deepEqual(await v1.json(), {
      object: 'list',
      model: 'llama-rerank',
      results: [{ index: 0, relevance_score: 0.95, document: 'Relay is a local gateway.' }],
      usage: { total_tokens: 0 },
    });

    const legacy = await app.fetch('/rerank', { method: 'POST', body: request });
    assert.equal(legacy.status, 200);
  });
});

test('rerank unsupported and invalid input fail cleanly', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 501, { error: 'missing' });
    const app = createApp(testConfig(upstream.url));

    const unsupported = await app.fetch('/v1/rerank', {
      method: 'POST',
      body: { model: 'local', query: 'x', documents: ['a'] },
    });
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).error.code, 'rerank_unsupported');

    const invalid = await app.fetch('/v1/rerank', {
      method: 'POST',
      body: { model: 'local', query: 'x', documents: [1] },
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error.message, /documents must be an array of strings/i);
  });
});

function testConfig(upstreamBaseUrl: string): AppConfig {
  return {
    port: 8080,
    host: '127.0.0.1',
    upstreamBaseUrl,
    samplingDefaults: {},
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
  };
}

async function withUpstream(run: (upstream: { url: string; handler: Handler }) => Promise<void>) {
  const upstream = {
    url: '',
    handler: ((_req: IncomingMessage, _res: ServerResponse) => {
      throw new Error('upstream handler not set');
    }) as Handler,
  };
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    await upstream.handler(req, res, body);
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

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
