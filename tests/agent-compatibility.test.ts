import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

test('mock OpenAI SDK scenarios work across models, chat, streaming, responses, and token aliasing', async () => {
  await withUpstream(async (upstream) => {
    const upstreamBodies: any[] = [];
    upstream.handler = async (req, res, body) => {
      upstreamBodies.push(body);
      if (req.url === '/v1/models') {
        sendJson(res, 200, { object: 'list', data: [{ id: 'llama', object: 'model' }] });
      } else if ((body as any)?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"chatcmpl-sdk","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"chatcmpl-sdk","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        sendJson(res, 200, chatCompletion('llama', { role: 'assistant', content: 'hello' }, 'stop'));
      }
    };
    const app = createApp(testConfig(upstream.url));

    assert.equal((await app.fetch('/v1/models')).status, 200);
    const chat = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', max_completion_tokens: 9, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(chat.status, 200);
    const stream = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.match(await stream.text(), /data: \[DONE\]/);
    const response = await app.fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'hi' },
    });
    assert.equal((await response.json()).object, 'response');
    assert.equal(upstreamBodies.find((body) => body?.max_tokens === 9)?.max_tokens, 9);
  });
});

test('mock Anthropic scenarios work for non-streaming, streaming, tools, and tool results', async () => {
  await withUpstream(async (upstream) => {
    const upstreamBodies: any[] = [];
    upstream.handler = async (_req, res, body) => {
      upstreamBodies.push(body);
      if ((body as any)?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"chatcmpl-anthropic","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
        res.end('data: {"id":"chatcmpl-anthropic","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      } else {
        sendJson(res, 200, chatCompletion('llama', {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"query":"relay"}' } }],
        }, 'tool_calls'));
      }
    };
    const app = createApp(testConfig(upstream.url));

    const toolResponse = await app.fetch('/v1/messages', {
      method: 'POST',
      body: {
        model: 'llama',
        max_tokens: 20,
        messages: [
          { role: 'user', content: 'search' },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_prev', content: 'old result' }] },
        ],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      },
    });
    const toolBody = await toolResponse.json();
    assert.equal(toolBody.content[0].type, 'tool_use');
    assert.deepEqual(toolBody.content[0].input, { query: 'relay' });

    const stream = await app.fetch('/v1/messages', {
      method: 'POST',
      body: { model: 'llama', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.match(await stream.text(), /event: message_stop/);

    const firstBody = upstreamBodies[0];
    assert.equal(firstBody.messages.filter((message: any) => message.role === 'tool').length, 1);
  });
});

test('agent regression guardrails prevent prompt accumulation, duplicated systems, replayed tools, malformed SSE, and unsupported-field crashes', async () => {
  await withUpstream(async (upstream) => {
    const upstreamBodies: any[] = [];
    upstream.handler = async (_req, res, body) => {
      upstreamBodies.push(body);
      if ((body as any)?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"id":"chatcmpl-regression","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
      } else if ((body as any)?.messages?.some((message: any) => message.content === 'empty')) {
        sendJson(res, 200, chatCompletion('llama', { role: 'assistant', content: '' }, 'length'));
      } else {
        sendJson(res, 200, chatCompletion('llama', { role: 'assistant', content: 'ok' }, 'stop'));
      }
    };
    const app = createApp(testConfig(upstream.url));
    const baseMessages = [
      { role: 'system', content: 'system once' },
      { role: 'user', content: 'hello' },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool result once' },
    ];

    for (let i = 0; i < 2; i++) {
      const response = await app.fetch('/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'llama',
          messages: baseMessages,
          service_tier: 'auto',
          prompt_cache_key: 'ignored',
          web_search_options: { enabled: true },
        },
      });
      assert.equal(response.status, 200);
    }

    for (const body of upstreamBodies.slice(0, 2)) {
      assert.equal(body.messages.length, 3);
      assert.equal(body.messages.filter((message: any) => message.role === 'system').length, 1);
      assert.equal(body.messages.filter((message: any) => message.role === 'tool').length, 1);
      assert.equal(JSON.stringify(body).includes('web_search_options'), false);
    }

    const stream = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    assertSSEFrames(await stream.text());

    const empty = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'user', content: 'empty' }] },
    });
    assert.equal(empty.status, 502);
  });
});

function assertSSEFrames(text: string) {
  for (const frame of text.trim().split('\n\n')) {
    assert.match(frame, /^data: /);
    const data = frame.slice('data: '.length);
    if (data !== '[DONE]') JSON.parse(data);
  }
}

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
    id: 'chatcmpl-agent',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
