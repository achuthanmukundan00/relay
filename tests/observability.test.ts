import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

test('observability endpoints expose bounded stats and request history without prompt bodies', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      if ((body as any)?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"chatcmpl-obs","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      sendJson(res, 200, {
        id: 'chatcmpl-obs',
        object: 'chat.completion',
        created: 1,
        model: 'llama',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    };
    const app = createApp({ ...testConfig(upstream.url), requestHistoryLimit: 2 });

    const health = await app.fetch('/health');
    const failed = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama' },
    });
    const streamed = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    await streamed.text();

    assert.equal(health.headers.get('x-relay-request-id') !== null, true);
    assert.equal(health.headers.get('x-relay-model-profile'), 'generic');
    assert.equal(failed.status, 400);

    const requests = await app.fetch('/relay/requests');
    assert.equal(requests.status, 200);
    const requestsBody = await requests.json();
    assert.equal(requestsBody.object, 'list');
    assert.equal(requestsBody.data.length, 2);
    assert.equal(requestsBody.data[0].route, '/v1/chat/completions');
    assert.equal(requestsBody.data[0].streaming, true);
    assert.equal('messages' in requestsBody.data[0], false);
    assert.equal(requestsBody.data[1].error_code, 'missing_required_field');
    assert.equal(requestsBody.data[1].failure_classification, 'client_request_incompatibility');

    const stats = await app.fetch('/relay/stats');
    assert.equal(stats.status, 200);
    const statsBody = await stats.json();
    assert.equal(statsBody.requests_total, 4);
    assert.equal(statsBody.requests_failed, 1);
    assert.equal(statsBody.streaming_requests_total, 1);
    assert.equal(statsBody.tool_calls_total, 0);
    assert.equal(statsBody.tool_parse_errors_total, 0);
    assert.equal(statsBody.upstream_errors_total, 0);
    assert.equal(typeof statsBody.average_latency_ms, 'number');
    assert.equal(typeof statsBody.started_at, 'string');

    const detail = await app.fetch(`/relay/requests/${health.headers.get('x-relay-request-id')}`);
    assert.equal(detail.status, 404);
  });
});

test('observability endpoints honor relay API key auth when configured', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, {});
    const app = createApp({ ...testConfig(upstream.url), apiKey: 'secret' });

    const unauthorized = await app.fetch('/relay/stats');
    assert.equal(unauthorized.status, 401);

    const authorized = await app.fetch('/relay/stats', {
      headers: { authorization: 'Bearer secret' },
    });
    assert.equal(authorized.status, 200);
  });
});

test('request detail returns the recorded summary when still inside the history window', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, {
      id: 'chatcmpl-obs',
      object: 'chat.completion',
      created: 1,
      model: 'llama',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', logprobs: null }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    const app = createApp(testConfig(upstream.url));

    const response = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'user', content: 'hi' }] },
    });
    const requestId = response.headers.get('x-relay-request-id');
    assert.equal(typeof requestId, 'string');
    await delay();

    const detail = await app.fetch(`/relay/requests/${requestId}`);
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.endpoint, '/v1/chat/completions');
    assert.equal(body.client, null);
    assert.equal(body.route, '/v1/chat/completions');
    assert.equal(body.model, 'llama');
    assert.equal(body.prompt_tokens, 2);
    assert.equal(body.total_tokens, 3);
    assert.equal(body.upstream_status ?? null, null);
    assert.equal(body.failure_classification ?? null, null);
  });
});

test('observability records upstream timeout and auth failures with the local-agent classification buckets', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    const app = createApp({ ...testConfig(upstream.url), apiKey: 'secret', requestTimeoutMs: 10 });

    const unauthorized = await app.fetch('/v1/models');
    assert.equal(unauthorized.status, 401);

    const timedOut = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: { model: 'llama', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(timedOut.status, 504);

    const requests = await app.fetch('/relay/requests', {
      headers: { authorization: 'Bearer secret' },
    });
    const body = await requests.json();
    assert.doesNotMatch(JSON.stringify(body), /Bearer secret/);
    const classifications = body.data.map((entry: any) => entry.failure_classification).filter(Boolean);
    assert.equal(classifications.includes('cloudflare_auth_failure'), true);
    assert.equal(classifications.includes('hardware_resource_timeout'), true);
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

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
