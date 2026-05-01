import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { anthropicEventsToOpenAIChunks, encodeSSE, parseSSEStream } from '../src/normalize/stream.ts';
import { createApp } from '../src/server.ts';

test('encodeSSE emits provider-compatible SSE frames', () => {
  assert.equal(encodeSSE({ event: 'message_delta', data: { ok: true } }), 'event: message_delta\ndata: {"ok":true}\n\n');
  assert.equal(encodeSSE({ data: '[DONE]' }), 'data: [DONE]\n\n');
});

test('OpenAI streaming appends DONE when upstream disconnects without it', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
    };
    const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"content":"hi"/);
    assert.match(text, /data: \[DONE\]\n\n$/);
  });
});

test('shared SSE parser handles frames split across network reads', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"hel'));
      controller.enqueue(encoder.encode('lo":"world"}\n\n'));
      controller.enqueue(encoder.encode('data: [DO'));
      controller.enqueue(encoder.encode('NE]\n\n'));
      controller.close();
    },
  });

  const frames: Array<{ event?: string; data: string }> = [];
  for await (const frame of parseSSEStream(body)) frames.push(frame);

  assert.deepEqual(frames, [
    { event: undefined, data: '{"hello":"world"}' },
    { event: undefined, data: '[DONE]' },
  ]);
});

test('OpenAI streaming emits DONE only once when upstream duplicates it', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end('data: [DONE]\n\n');
    };
    const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });

    const text = await response.text();
    assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
  });
});

test('Anthropic streaming preserves tool call argument chunks as input_json_delta', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"query\\""}}]},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"relay\\"}"}}]},"finish_reason":null}]}\n\n');
      res.end('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    };

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/messages', {
      method: 'POST',
      body: { model: 'llama', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"type":"tool_use","id":"call_1","name":"lookup"/);
    assert.match(text, /"type":"input_json_delta","partial_json":"{\\\"query\\\""/);
    assert.match(text, /"type":"input_json_delta","partial_json":":\\\"relay\\\"}"/);
    assert.doesNotMatch(text, /\[DONE\]/);
  });
});

test('Responses streaming emits response.failed on malformed upstream JSON after stream start', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
      res.end('data: {"id":\n\n');
    };

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'hi', stream: true },
    });

    const text = await response.text();
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /event: response\.failed/);
    assert.doesNotMatch(text, /event: response\.completed/);
  });
});

test('Anthropic streaming emits error event on malformed upstream JSON after stream start', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
      res.end('data: {"id":\n\n');
    };

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/messages', {
      method: 'POST',
      body: { model: 'llama', max_tokens: 4, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });

    const text = await response.text();
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /event: error/);
    assert.doesNotMatch(text, /event: message_stop/);
  });
});

test('Anthropic-style internal events convert to OpenAI chat chunks', () => {
  const chunks = anthropicEventsToOpenAIChunks([
    { event: 'message_start', data: { message: { id: 'msg_1', model: 'llama' } } },
    { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'hi' } } },
    { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' } } },
    { event: 'message_stop', data: {} },
  ]);

  assert.match(chunks[0], /"object":"chat.completion.chunk"/);
  assert.match(chunks.join(''), /"content":"hi"/);
  assert.equal(chunks.at(-1), 'data: [DONE]\n\n');
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
  };
}

async function withUpstream(run: (upstream: { url: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => Promise<void>) {
  const upstream = {
    url: '',
    handler: (_req: IncomingMessage, _res: ServerResponse) => {
      throw new Error('upstream handler not set');
    },
  };
  const server = createServer((req, res) => upstream.handler(req, res));
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
