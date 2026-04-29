import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

test('POST /v1/responses maps string input to chat completion and stores response', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (req, res, body) => {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal((body as any).max_tokens, 12);
      assert.deepEqual((body as any).messages, [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hello' },
      ]);
      sendJson(res, 200, chatCompletion('llama', 'hi'));
    };
    const app = createApp(testConfig(upstream.url));

    const create = await app.fetch('/v1/responses', {
      method: 'POST',
      body: {
        model: 'llama',
        instructions: 'Be concise.',
        input: 'hello',
        max_output_tokens: 12,
      },
    });

    const text = await create.text();
    assert.equal(create.status, 200, text);
    const response = JSON.parse(text);
    assert.equal(response.object, 'response');
    assert.equal(response.status, 'completed');
    assert.deepEqual(response.output[0].content[0], { type: 'output_text', text: 'hi' });

    const get = await app.fetch(`/v1/responses/${response.id}`);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).id, response.id);
  });
});

test('POST /v1/responses accepts message-array input and tools', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.equal((body as any).tool_choice, 'auto');
      assert.equal((body as any).tools[0].function.name, 'lookup');
      assert.deepEqual((body as any).messages, [{ role: 'user', content: 'hello' }]);
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/responses', {
      method: 'POST',
      body: {
        model: 'llama',
        input: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
      },
    });

    assert.equal(res.status, 200);
  });
});

test('DELETE /v1/responses/:id removes cached response', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', 'bye'));
    const app = createApp(testConfig(upstream.url));
    const create = await app.fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'hello' },
    });
    const response = await create.json();

    const deleted = await app.fetch(`/v1/responses/${response.id}`, { method: 'DELETE' });
    assert.deepEqual(await deleted.json(), { id: response.id, object: 'response.deleted', deleted: true });

    const missing = await app.fetch(`/v1/responses/${response.id}`);
    assert.equal(missing.status, 404);
    assert.equal(typeof (await missing.json()).error.message, 'string');
  });
});

test('POST /v1/responses stream emits Responses-style SSE without OpenAI DONE', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
      res.end('data: [DONE]\n\n');
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'hello', stream: true },
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /event: response\.completed/);
    assert.doesNotMatch(text, /\[DONE\]/);
  });
});

function testConfig(upstreamBaseUrl: string): AppConfig {
  return {
    port: 8080,
    host: '127.0.0.1',
    upstreamBaseUrl,
    requestTimeoutMs: 1_000,
    logLevel: 'silent',
    completionTtlMs: 3_600_000,
  };
}

async function withUpstream(run: (upstream: { url: string; handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void> }) => Promise<void>) {
  const upstream = {
    url: '',
    handler: (_req: IncomingMessage, _res: ServerResponse, _body: unknown) => {
      throw new Error('upstream handler not set');
    },
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    await upstream.handler(req, res, text ? JSON.parse(text) : undefined);
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

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function chatCompletion(model: string, content: string) {
  return {
    id: 'chatcmpl-response',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}
