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
    assert.equal(response.output[0].status, 'completed');
    assert.deepEqual(response.output[0].content[0], { type: 'output_text', text: 'hi' });
    assert.deepEqual(response.usage, { input_tokens: 2, output_tokens: 1, total_tokens: 3 });

    const get = await app.fetch(`/v1/responses/${response.id}`);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).id, response.id);
  });
});

test('POST /v1/responses accepts message-array input and tools', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.equal((body as any).tool_choice, 'auto');
      assert.equal((body as any).parallel_tool_calls, false);
      assert.equal((body as any).tools[0].function.name, 'lookup');
      assert.deepEqual((body as any).messages, [{ role: 'user', content: 'hello' }]);
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };
    const res = await createApp({ ...testConfig(upstream.url), upstreamVisionOk: true }).fetch('/v1/responses', {
      method: 'POST',
      body: {
        model: 'llama',
        input: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
        parallel_tool_calls: false,
      },
    });

    assert.equal(res.status, 200);
  });
});

test('POST /v1/responses accepts Responses SDK function tool shape', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.equal((body as any).tool_choice, 'auto');
      assert.equal((body as any).tools[0].type, 'function');
      assert.equal((body as any).tools[0].function.name, 'lookup');
      assert.deepEqual((body as any).tools[0].function.parameters, {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      });
      sendJson(res, 200, {
        id: 'chatcmpl-response',
        object: 'chat.completion',
        created: 1,
        model: 'llama',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"ok":true}' },
            }],
          },
          finish_reason: 'tool_calls',
          logprobs: null,
        }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    };

    const res = await createApp(testConfig(upstream.url)).fetch('/v1/responses', {
      method: 'POST',
      body: {
        model: 'llama',
        input: 'Use the tool',
        tools: [{
          type: 'function',
          name: 'lookup',
          description: 'Lookup',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        }],
        tool_choice: 'auto',
        store: false,
      },
    });

    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.output[0].content[0].type, 'function_call');
    assert.equal(body.output[0].content[0].name, 'lookup');
  });
});

test('POST /v1/responses accepts Responses SDK function tool_choice shape', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.deepEqual((body as any).tool_choice, {
        type: 'function',
        function: { name: 'lookup' },
      });
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };

    const res = await createApp(testConfig(upstream.url)).fetch('/v1/responses', {
      method: 'POST',
      body: {
        model: 'llama',
        input: 'Use the tool',
        tools: [{
          type: 'function',
          name: 'lookup',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
          },
        }],
        tool_choice: { type: 'function', name: 'lookup' },
        store: false,
      },
    });

    assert.equal(res.status, 200, await res.text());
  });
});

test('POST /v1/responses normalizes response-style input content parts and metadata', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.deepEqual((body as any).messages, [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } },
          ],
        },
      ]);
      assert.deepEqual((body as any).response_format, { type: 'json_object' });
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };
    const res = await createApp({ ...testConfig(upstream.url), upstreamVisionOk: true }).fetch('/v1/responses', {
      method: 'POST',
      body: {
        model: 'llama',
        metadata: { source: 'test' },
        response_format: { type: 'json_object' },
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'hello' },
            { type: 'input_image', image_url: 'https://example.test/cat.png' },
          ],
        }],
      },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.metadata, { source: 'test' });
  });
});

test('POST /v1/responses with store false does not persist the response', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', 'no-store'));
    const app = createApp(testConfig(upstream.url));
    const create = await app.fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'hello', store: false },
    });
    const body = await create.json();

    const missing = await app.fetch(`/v1/responses/${body.id}`);
    assert.equal(missing.status, 404);
  });
});

test('POST /v1/responses validates previous_response_id against stored responses', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', 'hi'));
    const app = createApp(testConfig(upstream.url));
    const first = await app.fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'hello', store: true },
    });
    const previous = await first.json();

    const followup = await app.fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'again', previous_response_id: previous.id },
    });
    assert.equal(followup.status, 200);
    assert.equal((await followup.json()).previous_response_id, previous.id);

    const missing = await app.fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'again', previous_response_id: 'resp_missing' },
    });
    assert.equal(missing.status, 404);
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

test('Responses unknown fields follow the configured field policy', async (t) => {
  await t.test('pass through by default', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = async (_req, res, body) => {
        assert.equal((body as any).llama_extra, true);
        sendJson(res, 200, chatCompletion('llama', 'ok'));
      };
      const res = await createApp(testConfig(upstream.url)).fetch('/v1/responses', {
        method: 'POST',
        body: { model: 'llama', input: 'hello', llama_extra: true },
      });
      assert.equal(res.status, 200, await res.text());
    });
  });

  await t.test('strip with warning', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = async (_req, res, body) => {
        assert.equal('llama_extra' in (body as any), false);
        sendJson(res, 200, chatCompletion('llama', 'ok'));
      };
      const res = await createApp({ ...testConfig(upstream.url), unknownFieldPolicy: 'strip' }).fetch('/v1/responses', {
        method: 'POST',
        body: { model: 'llama', input: 'hello', llama_extra: true },
      });
      assert.equal(res.status, 200, await res.text());
      assert.equal(res.headers.get('x-relay-warning'), 'stripped_unsupported_fields');
    });
  });

  await t.test('reject', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = () => assert.fail('rejected field should not call upstream');
      const res = await createApp({ ...testConfig(upstream.url), unknownFieldPolicy: 'reject' }).fetch('/v1/responses', {
        method: 'POST',
        body: { model: 'llama', input: 'hello', llama_extra: true },
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'unsupported_parameter');
    });
  });
});

test('Responses hosted-only fields strip permissively and reject in strict compatibility mode', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.equal('service_tier' in (body as any), false);
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'hello', service_tier: 'auto' },
    });
    assert.equal(res.status, 200, await res.text());
    assert.equal(res.headers.get('x-relay-warning'), 'stripped_unsupported_fields');
  });

  await withUpstream(async (upstream) => {
    upstream.handler = () => assert.fail('strict hosted-only field should not call upstream');
    const res = await createApp({ ...testConfig(upstream.url), strictCompat: true }).fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'hello', service_tier: 'auto' },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.type, 'unsupported_capability');
    assert.equal(body.error.code, 'unsupported_capability');
  });
});

test('Responses hosted tools are rejected explicitly', async () => {
  const res = await createApp(testConfig('http://127.0.0.1:9')).fetch('/v1/responses', {
    method: 'POST',
    body: {
      model: 'llama',
      input: 'hello',
      tools: [{ type: 'web_search' }],
    },
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, 'unsupported_capability');
  assert.equal(body.error.code, 'unsupported_capability');
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
