import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import { createApp } from '../src/server.ts';
import type { AppConfig } from '../src/config.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>;

test('GET /health returns ok true', async () => {
  await withUpstream(async (upstream) => {
    const app = createApp(testConfig(upstream.url));
    const res = await app.fetch('/health');

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('GET / returns gateway metadata for agent probes', async () => {
  await withUpstream(async (upstream) => {
    const res = await createApp(testConfig(upstream.url)).fetch('/');

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'gateway');
    assert.deepEqual(body.endpoints, ['/health', '/v1/models', '/v1/chat/completions', '/v1/completions', '/v1/messages']);
  });
});

test('OPTIONS returns CORS-friendly probe response', async () => {
  await withUpstream(async (upstream) => {
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'OPTIONS',
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
  });
});

test('GET /v1/models passes through upstream model list', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (req, res) => {
      assert.equal(req.url, '/v1/models');
      sendJson(res, 200, { object: 'list', data: [{ id: 'llama', object: 'model' }] });
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/models');

    assert.equal(res.status, 200);
    assert.equal((await res.json()).data[0].id, 'llama');
  });
});

test('capability endpoints expose and refresh upstream model state', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (req, res, body) => {
      if (req.url === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      if (req.url === '/v1/models') {
        sendJson(res, 200, { object: 'list', data: [{ id: 'llama', object: 'model' }] });
        return;
      }
      if (req.url === '/v1/chat/completions') {
        assert.equal((body as any).max_tokens, 1);
        sendJson(res, 200, upstreamChat('llama', 'ok'));
        return;
      }
      if (req.url === '/tokenize') {
        sendJson(res, 200, { tokens: [1, 2] });
        return;
      }
      assert.fail(`unexpected upstream path ${req.url}`);
    };
    const app = createApp(testConfig(upstream.url));

    const initial = await app.fetch('/relay/capabilities');
    assert.equal(initial.status, 200);
    assert.equal((await initial.json()).models.list, 'unknown');

    const refreshed = await app.fetch('/relay/capabilities/refresh', { method: 'POST' });
    assert.equal(refreshed.status, 200);
    const body = await refreshed.json();
    assert.equal(body.upstream.reachable, true);
    assert.equal(body.upstream.health, 'available');
    assert.equal(body.models.list, 'available');
    assert.equal(body.models.currentModel, 'llama');
    assert.equal(body.endpoints.chatCompletions, 'implemented');
    assert.equal(body.endpoints.embeddings, 'unsupported');
    assert.equal(body.features.chatCompletions, 'available');
    assert.equal(body.features.tokenization, 'available');
    assert.equal(body.features.multimodalInput, 'unknown');
  });
});

test('capability refresh marks upstream offline without failing Relay', async () => {
  const app = createApp({ ...testConfig('http://127.0.0.1:9'), probeTimeoutMs: 10 });

  const refreshed = await app.fetch('/relay/capabilities/refresh', { method: 'POST' });
  assert.equal(refreshed.status, 200);
  const body = await refreshed.json();
  assert.equal(body.upstream.reachable, false);
  assert.equal(body.models.list, 'unknown');
  assert.equal(body.endpoints.responses, 'implemented');
  assert.equal(body.endpoints.rerank, 'unsupported');
  assert.equal(body.features.chatCompletions, 'unknown');
});

test('capability refresh does not overclaim when upstream only serves models', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (req, res) => {
      if (req.url === '/v1/models') {
        sendJson(res, 200, { object: 'list', data: [{ id: 'llama', object: 'model' }] });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing' }));
    };
    const app = createApp(testConfig(upstream.url));

    const refreshed = await app.fetch('/relay/capabilities/refresh', { method: 'POST' });
    const body = await refreshed.json();
    assert.equal(body.upstream.reachable, true);
    assert.equal(body.models.list, 'available');
    assert.equal(body.features.chatCompletions, 'unsupported');
    assert.equal(body.features.tokenization, 'unsupported');
  });
});

test('strict startup fails when upstream is offline', async () => {
  const app = createApp({
    ...testConfig('http://127.0.0.1:9'),
    probeOnStartup: true,
    strictStartup: true,
    probeTimeoutMs: 10,
  });

  await assert.rejects(app.listen(), /unreachable/);
});

test('GET /v1/models returns synthetic list when upstream fails and DEFAULT_MODEL exists', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 503, { error: 'down' });
    const app = createApp({ ...testConfig(upstream.url), defaultModel: 'fallback-model' });
    const res = await app.fetch('/v1/models');

    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data[0], {
      id: 'fallback-model',
      object: 'model',
      created: 0,
      owned_by: 'local',
    });
  });
});

test('GET /v1/models returns OpenAI-shaped error without fallback', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 503, { error: 'down' });
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/models');
    await assertOpenAIError(res, 502);
  });
});

test('GET /v1/models/:model passes through upstream model lookup', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (req, res) => {
      assert.equal(req.url, '/v1/models/llama');
      sendJson(res, 200, { id: 'llama', object: 'model' });
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/models/llama');

    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, 'llama');
  });
});

test('POST /v1/chat/completions returns OpenAI-compatible non-streaming completion', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.equal((body as any).model, 'llama');
      sendJson(res, 200, upstreamChat('llama', 'hi there'));
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'user', content: 'hello' }] },
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(typeof json.id, 'string');
    assert.equal(json.object, 'chat.completion');
    assert.equal(typeof json.created, 'number');
    assert.equal(json.model, 'llama');
    assert.ok(Array.isArray(json.choices));
    assert.equal(json.choices[0].message.role, 'assistant');
    assert.equal(json.choices[0].message.content, 'hi there');
    assert.deepEqual(json.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  });
});

test('POST /v1/chat/completions applies configurable sampling defaults', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.equal((body as any).temperature, 1.0);
      assert.equal((body as any).top_p, 0.95);
      assert.equal((body as any).top_k, 20);
      assert.equal((body as any).min_p, 0.0);
      assert.equal((body as any).presence_penalty, 1.5);
      assert.equal((body as any).repeat_penalty, 1.0);
      sendJson(res, 200, upstreamChat('llama', 'hi there'));
    };
    const app = createApp({
      ...testConfig(upstream.url),
      samplingDefaults: {
        temperature: 1.0,
        top_p: 0.95,
        top_k: 20,
        min_p: 0.0,
        presence_penalty: 1.5,
        repeat_penalty: 1.0,
      },
    });
    const res = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'user', content: 'hello' }] },
    });

    assert.equal(res.status, 200);
  });
});

test('POST /v1/completions maps legacy prompts to chat completions', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (req, res, body) => {
      assert.equal(req.url, '/v1/chat/completions');
      assert.deepEqual((body as any).messages, [{ role: 'user', content: 'hello' }]);
      sendJson(res, 200, upstreamChat('llama', 'hi legacy'));
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/completions', {
      method: 'POST',
      body: { model: 'llama', prompt: 'hello', max_tokens: 16 },
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, 'text_completion');
    assert.equal(json.choices[0].text, 'hi legacy');
  });
});

test('POST /v1/chat/completions streams SSE chunks and done marker', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (req, res) => {
      assert.equal(req.headers.accept, 'text/event-stream');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
      res.end('data: [DONE]\n\n');
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', stream: true, messages: [{ role: 'user', content: 'hello' }] },
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(await res.text(), /data: \[DONE\]\n\n/);
  });
});

test('normalizes chat requests for agent compatibility', async (t) => {
  const cases: Array<{
    name: string;
    patch: Record<string, unknown>;
    assertBody: (body: any) => void;
  }> = [
    {
      name: 'max_completion_tokens aliases to max_tokens',
      patch: { max_completion_tokens: 7 },
      assertBody: (body) => {
        assert.equal(body.max_tokens, 7);
        assert.equal('max_completion_tokens' in body, false);
      },
    },
    {
      name: 'max_tokens wins when both token fields exist',
      patch: { max_tokens: 5, max_completion_tokens: 7 },
      assertBody: (body) => assert.equal(body.max_tokens, 5),
    },
    {
      name: 'developer messages become system messages',
      patch: { messages: [{ role: 'developer', content: 'rules' }] },
      assertBody: (body) => assert.deepEqual(body.messages[0], { role: 'system', content: 'rules' }),
    },
    {
      name: 'string content passes through',
      patch: { messages: [{ role: 'user', content: 'plain text' }] },
      assertBody: (body) => assert.equal(body.messages[0].content, 'plain text'),
    },
    {
      name: 'text content parts become upstream text',
      patch: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }] },
      assertBody: (body) => assert.equal(body.messages[0].content, 'hello\nworld'),
    },
    {
      name: 'function messages are accepted as tool messages',
      patch: { messages: [{ role: 'function', name: 'lookup', content: 'ok' }] },
      assertBody: (body) => {
        assert.equal(body.messages[0].role, 'tool');
        assert.equal(body.messages[0].tool_call_id, 'lookup');
      },
    },
    {
      name: 'tool messages preserve tool_call_id',
      patch: { messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }] },
      assertBody: (body) => assert.equal(body.messages[0].tool_call_id, 'call_1'),
    },
    {
      name: 'assistant null content with tool calls passes through',
      patch: {
        messages: [{
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
        }],
      },
      assertBody: (body) => {
        assert.equal(body.messages[0].content, null);
        assert.equal(body.messages[0].tool_calls[0].function.name, 'lookup');
      },
    },
    {
      name: 'modern tools pass through',
      patch: {
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' }, strict: true } }],
        tool_choice: { type: 'function', function: { name: 'lookup' } },
      },
      assertBody: (body) => {
        assert.equal(body.tools[0].function.name, 'lookup');
        assert.equal(body.tool_choice.function.name, 'lookup');
      },
    },
    {
      name: 'tool_choice auto passes through',
      patch: { tool_choice: 'auto' },
      assertBody: (body) => assert.equal(body.tool_choice, 'auto'),
    },
    {
      name: 'tool_choice none passes through',
      patch: { tool_choice: 'none' },
      assertBody: (body) => assert.equal(body.tool_choice, 'none'),
    },
    {
      name: 'tool_choice required passes through',
      patch: { tool_choice: 'required' },
      assertBody: (body) => assert.equal(body.tool_choice, 'required'),
    },
    {
      name: 'forced tool_choice maps tool name to function choice',
      patch: { tool_choice: { type: 'tool', name: 'lookup' } },
      assertBody: (body) => assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'lookup' } }),
    },
    {
      name: 'deprecated functions convert to tools',
      patch: { functions: [{ name: 'lookup', parameters: { type: 'object' } }] },
      assertBody: (body) => {
        assert.equal(body.tools[0].type, 'function');
        assert.equal(body.tools[0].function.name, 'lookup');
      },
    },
    {
      name: 'deprecated function_call converts to tool_choice',
      patch: { function_call: { name: 'lookup' } },
      assertBody: (body) => assert.equal(body.tool_choice.function.name, 'lookup'),
    },
    {
      name: 'response_format text passes through',
      patch: { response_format: { type: 'text' } },
      assertBody: (body) => assert.equal(body.response_format.type, 'text'),
    },
    {
      name: 'response_format json_object passes through',
      patch: { response_format: { type: 'json_object' } },
      assertBody: (body) => assert.equal(body.response_format.type, 'json_object'),
    },
    {
      name: 'response_format json_schema passes through',
      patch: { response_format: { type: 'json_schema', json_schema: { name: 'result' } } },
      assertBody: (body) => assert.equal(body.response_format.type, 'json_schema'),
    },
    {
      name: 'unknown cloud-only fields are ignored safely',
      patch: { service_tier: 'auto', metadata: { trace: '1' }, user: 'user-1' },
      assertBody: (body) => {
        assert.equal('service_tier' in body, false);
        assert.deepEqual(body.metadata, { trace: '1' });
        assert.equal(body.user, 'user-1');
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withUpstream(async (upstream) => {
        upstream.handler = (_req, res, body) => {
          item.assertBody(body);
          sendJson(res, 200, upstreamChat('llama', 'ok'));
        };
        const request = {
          model: 'llama',
          messages: [{ role: 'user', content: 'hello' }],
          ...item.patch,
        };
        const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
          method: 'POST',
          body: request,
        });
        assert.equal(res.status, 200, await res.text());
      });
    });
  }
});

test('invalid OpenAI chat roles return OpenAI-shaped errors without calling upstream', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = () => assert.fail('invalid role should not call upstream');
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'critic', content: 'nope' }] },
    });
    await assertOpenAIError(res, 400);
  });
});

test('unsupported content modalities return 400 without calling upstream', async (t) => {
  for (const type of ['image_url', 'input_audio', 'file']) {
    await t.test(type, async () => {
      await withUpstream(async (upstream) => {
        upstream.handler = () => assert.fail('unsupported modality should not call upstream');
        const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
          method: 'POST',
          body: { model: 'llama', messages: [{ role: 'user', content: [{ type }] }] },
        });
        await assertOpenAIError(res, 400);
      });
    });
  }
});

test('strict compatibility rejects unknown json_schema response_format support', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = () => assert.fail('strict response_format rejection should not call upstream');
    const res = await createApp({ ...testConfig(upstream.url), strictCompat: true }).fetch('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'llama',
        messages: [{ role: 'user', content: 'hello' }],
        response_format: { type: 'json_schema', json_schema: { name: 'result' } },
      },
    });
    await assertOpenAIError(res, 400);
  });
});

test('unknown OpenAI chat fields follow the configured field policy', async (t) => {
  await t.test('pass through by default', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = (_req, res, body) => {
        assert.equal((body as any).llama_extra, true);
        sendJson(res, 200, upstreamChat('llama', 'ok'));
      };
      const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'llama', llama_extra: true, messages: [{ role: 'user', content: 'hello' }] },
      });
      assert.equal(res.status, 200, await res.text());
    });
  });

  await t.test('strip with warning', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = (_req, res, body) => {
        assert.equal('llama_extra' in (body as any), false);
        sendJson(res, 200, upstreamChat('llama', 'ok'));
      };
      const res = await createApp({ ...testConfig(upstream.url), unknownFieldPolicy: 'strip' }).fetch('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'llama', llama_extra: true, messages: [{ role: 'user', content: 'hello' }] },
      });
      assert.equal(res.status, 200, await res.text());
      assert.equal(res.headers.get('x-relay-warning'), 'stripped_unsupported_fields');
    });
  });

  await t.test('reject', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = () => assert.fail('rejected field should not call upstream');
      const res = await createApp({ ...testConfig(upstream.url), unknownFieldPolicy: 'reject' }).fetch('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'llama', llama_extra: true, messages: [{ role: 'user', content: 'hello' }] },
      });
      await assertOpenAIError(res, 400);
    });
  });
});

test('hosted-only OpenAI chat fields strip permissively and reject in strict compatibility mode', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res, body) => {
      assert.equal('service_tier' in (body as any), false);
      sendJson(res, 200, upstreamChat('llama', 'ok'));
    };
    const permissive = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', service_tier: 'auto', messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(permissive.status, 200, await permissive.text());
    assert.equal(permissive.headers.get('x-relay-warning'), 'stripped_unsupported_fields');
  });

  await withUpstream(async (upstream) => {
    upstream.handler = () => assert.fail('strict hosted-only field should not call upstream');
    const strict = await createApp({ ...testConfig(upstream.url), strictCompat: true }).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', service_tier: 'auto', messages: [{ role: 'user', content: 'hello' }] },
    });
    await assertOpenAIError(strict, 400);
  });
});

test('unsupported custom tools return 400 without calling upstream', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = () => assert.fail('unsupported tool should not call upstream');
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'custom', name: 'shell' }] },
    });
    await assertOpenAIError(res, 400);
  });
});

test('stream_options.include_usage is accepted and usage chunks are preserved when upstream provides them', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
      res.end('data: [DONE]\n\n');
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'llama',
        stream: true,
        stream_options: { include_usage: true, include_obfuscation: true },
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /"usage"/);
  });
});

test('stored completion lifecycle supports list, get, metadata update, messages, and delete', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, upstreamChat('llama', 'stored'));
    const app = createApp(testConfig(upstream.url));

    const create = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', store: true, metadata: { kind: 'test' }, messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(create.status, 200);
    const created = await create.json();

    const list = await app.fetch('/v1/chat/completions?limit=10&model=llama&metadata.kind=test');
    const listed = await list.json();
    assert.equal(list.status, 200);
    assert.equal(listed.object, 'list');
    assert.equal(listed.first_id, created.id);
    assert.equal(listed.last_id, created.id);

    const get = await app.fetch(`/v1/chat/completions/${created.id}`);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).id, created.id);

    const update = await app.fetch(`/v1/chat/completions/${created.id}`, {
      method: 'POST',
      body: { metadata: { kind: 'updated' } },
    });
    assert.equal(update.status, 200);
    assert.equal((await update.json()).metadata.kind, 'updated');

    const messages = await app.fetch(`/v1/chat/completions/${created.id}/messages`);
    const messageList = await messages.json();
    assert.equal(messages.status, 200);
    assert.equal(messageList.object, 'list');
    assert.equal(messageList.data[0].role, 'user');

    const deleted = await app.fetch(`/v1/chat/completions/${created.id}`, { method: 'DELETE' });
    assert.deepEqual(await deleted.json(), {
      id: created.id,
      deleted: true,
      object: 'chat.completion.deleted',
    });

    await assertOpenAIError(await app.fetch(`/v1/chat/completions/${created.id}`), 404);
  });
});

test('store false does not persist completion', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, upstreamChat('llama', 'not stored'));
    const app = createApp(testConfig(upstream.url));
    const create = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', store: false, messages: [{ role: 'user', content: 'hello' }] },
    });
    const created = await create.json();

    await assertOpenAIError(await app.fetch(`/v1/chat/completions/${created.id}`), 404);
  });
});

test('stored completion update rejects non-metadata changes', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, upstreamChat('llama', 'stored'));
    const app = createApp(testConfig(upstream.url));
    const create = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', store: true, messages: [{ role: 'user', content: 'hello' }] },
    });
    const created = await create.json();

    const res = await app.fetch(`/v1/chat/completions/${created.id}`, {
      method: 'POST',
      body: { metadata: { ok: true }, model: 'other' },
    });
    await assertOpenAIError(res, 400);
  });
});

test('bad JSON returns OpenAI-shaped 400', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = () => assert.fail('bad json should not call upstream');
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: '{',
      headers: { 'content-type': 'application/json' },
    });
    await assertOpenAIError(res, 400);
  });
});

test('upstream unavailable and timeout map to OpenAI-shaped gateway errors', async (t) => {
  await t.test('unavailable', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = (_req, res) => sendJson(res, 503, { error: 'down' });
      const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'llama', messages: [{ role: 'user', content: 'hello' }] },
      });
      await assertOpenAIError(res, 502);
    });
  });

  await t.test('timeout', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = async (_req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        sendJson(res, 200, upstreamChat('llama', 'late'));
      };
      const config = { ...testConfig(upstream.url), requestTimeoutMs: 5 };
      const res = await createApp(config).fetch('/v1/chat/completions', {
        method: 'POST',
        body: { model: 'llama', messages: [{ role: 'user', content: 'hello' }] },
      });
      await assertOpenAIError(res, 504);
    });
  });
});

test('empty assistant response becomes 502 unless finish reason is a valid empty stop', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      const chat = upstreamChat('llama', '');
      chat.choices[0].finish_reason = 'length';
      sendJson(res, 200, chat);
    };
    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'user', content: 'hello' }] },
    });
    await assertOpenAIError(res, 502);
  });
});

function testConfig(upstreamBaseUrl: string): AppConfig {
  return {
    port: 8080,
    host: '127.0.0.1',
    upstreamBaseUrl,
    samplingDefaults: {},
    requestTimeoutMs: 1_000,
    logLevel: 'info',
    completionTtlMs: 3_600_000,
    maxRequestBodyBytes: 1_048_576,
  };
}

async function withUpstream(run: (upstream: { url: string; handler: Handler }) => Promise<void>) {
  const upstream: { url: string; handler: Handler } = {
    url: '',
    handler: () => {
      throw new Error('upstream handler not set');
    },
  };
  const server = createServer(async (req, res) => {
    const body = await readRequestBody(req);
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

async function readRequestBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  return JSON.parse(text);
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function assertOpenAIError(res: Response, status: number) {
  const text = await res.text();
  assert.equal(res.status, status, text);
  const json = JSON.parse(text);
  assert.equal(typeof json.error.message, 'string');
  assert.equal(typeof json.error.type, 'string');
  assert.equal(json.error.param === null || typeof json.error.param === 'string', true);
}

function upstreamChat(model: string, content: string): any {
  return {
    id: 'chatcmpl-upstream',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
