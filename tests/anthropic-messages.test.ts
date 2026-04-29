import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

test('POST /v1/messages maps Anthropic request to OpenAI chat and returns Anthropic message', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (req, res, body) => {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal((body as any).model, 'llama');
      assert.equal((body as any).max_tokens, 32);
      assert.deepEqual((body as any).stop, ['</stop>']);
      assert.equal((body as any).tool_choice.function.name, 'lookup');
      assert.equal((body as any).tools[0].function.name, 'lookup');
      assert.deepEqual((body as any).messages, [
        { role: 'system', content: 'Rules\nMore rules' },
        { role: 'user', content: 'hello' },
      ]);
      assert.equal('thinking' in (body as any), false);
      sendJson(res, 200, chatCompletion('llama', { role: 'assistant', content: 'hi' }, 'stop'));
    };

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/messages', {
      method: 'POST',
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools' },
      body: {
        model: 'llama',
        max_tokens: 32,
        system: [{ type: 'text', text: 'Rules' }, { type: 'text', text: 'More rules' }],
        messages: [{ role: 'user', content: 'hello' }],
        stop_sequences: ['</stop>'],
        tools: [{ name: 'lookup', description: 'Search', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'lookup' },
        thinking: { type: 'enabled' },
      },
    });

    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.type, 'message');
    assert.equal(body.role, 'assistant');
    assert.deepEqual(body.content, [{ type: 'text', text: 'hi' }]);
    assert.equal(body.stop_reason, 'end_turn');
    assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 1 });
  });
});

test('Anthropic tool_use and tool_result blocks map to OpenAI tool calls and tool messages', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.deepEqual((body as any).messages, [
        {
          role: 'assistant',
          content: 'Searching',
          tool_calls: [{
            id: 'toolu_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"relay"}' },
          }],
        },
        { role: 'user', content: 'Thanks' },
        { role: 'tool', tool_call_id: 'toolu_1', content: 'result text' },
      ]);
      sendJson(res, 200, chatCompletion('llama', {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"a.txt"}' },
        }],
      }, 'tool_calls'));
    };

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/messages', {
      method: 'POST',
      body: {
        model: 'llama',
        max_tokens: 64,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Searching' },
              { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { query: 'relay' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Thanks' },
              { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'result text' }] },
            ],
          },
        ],
      },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.stop_reason, 'tool_use');
    assert.deepEqual(body.content, [{ type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.txt' } }]);
  });
});

test('Anthropic auth accepts local unauthenticated mode, x-api-key, and bearer token', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', { role: 'assistant', content: 'ok' }, 'stop'));
    const open = createApp(testConfig(upstream.url));
    assert.equal((await open.fetch('/v1/messages', {
      method: 'POST',
      body: { model: 'llama', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    })).status, 200);

    const locked = createApp({ ...testConfig(upstream.url), apiKey: 'secret' });
    assert.equal((await locked.fetch('/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'secret' },
      body: { model: 'llama', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    })).status, 200);
    assert.equal((await locked.fetch('/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: { model: 'llama', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    })).status, 200);
    const unauthorized = await locked.fetch('/v1/messages', {
      method: 'POST',
      body: { model: 'llama', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).type, 'error');
  });
});

test('Anthropic malformed upstream tool arguments return Anthropic-shaped gateway error', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bad', arguments: '{"x":' } }],
    }, 'tool_calls'));

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/messages', {
      method: 'POST',
      body: { model: 'llama', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] },
    });

    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'api_error');
    assert.doesNotMatch(body.error.message, /SyntaxError|stack/i);
  });
});

test('Anthropic streaming converts OpenAI chunks to message events', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    };

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/messages', {
      method: 'POST',
      body: { model: 'llama', max_tokens: 4, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_start/);
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /event: message_delta/);
    assert.match(text, /event: message_stop/);
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
    maxRequestBodyBytes: 1_048_576,
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

function chatCompletion(model: string, message: unknown, finishReason: string) {
  return {
    id: 'chatcmpl-anthropic',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}
