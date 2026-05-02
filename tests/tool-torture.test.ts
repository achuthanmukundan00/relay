import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>;
type JsonObject = Record<string, any>;

const fixtureDir = join(import.meta.dirname, 'fixtures', 'tools');

test('Spec 12 OpenAI Chat request fixtures normalize common agent tool shapes', async (t) => {
  const cases: Array<{
    name: string;
    fixture: string;
    assertBody: (body: JsonObject) => void;
  }> = [
    {
      name: 'tools with one function and tool_choice auto',
      fixture: 'openai-basic-tool.json',
      assertBody: (body) => {
        assert.equal(body.tools.length, 1);
        assert.equal(body.tools[0].function.name, 'get_weather');
        assert.equal(body.tools[0].function.parameters.properties.unit.enum[0], 'celsius');
        assert.equal(body.tool_choice, 'auto');
      },
    },
    {
      name: 'forced tool choice by function name',
      fixture: 'openai-forced-tool.json',
      assertBody: (body) => {
        assert.equal(body.tools[0].function.name, 'read_file');
        assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'read_file' } });
      },
    },
    {
      name: 'multiple functions and parallel tool calls true',
      fixture: 'openai-parallel-tools.json',
      assertBody: (body) => {
        assert.deepEqual(body.tools.map((tool: JsonObject) => tool.function.name), ['search', 'read_file']);
        assert.equal(body.tools[1].function.parameters.properties.options.type, 'object');
        assert.equal(body.parallel_tool_calls, true);
      },
    },
    {
      name: 'legacy functions and function_call',
      fixture: 'openai-legacy-functions.json',
      assertBody: (body) => {
        assert.equal('functions' in body, false);
        assert.equal('function_call' in body, false);
        assert.equal(body.tools[0].type, 'function');
        assert.equal(body.tools[0].function.name, 'lookup_symbol');
        assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'lookup_symbol' } });
      },
    },
    {
      name: 'assistant tool_calls and tool result continuation',
      fixture: 'openai-tool-result-continuation.json',
      assertBody: (body) => {
        assert.equal(body.messages[1].content, null);
        assert.equal(body.messages[1].tool_calls[0].id, 'call_search_1');
        assert.equal(body.messages[2].role, 'tool');
        assert.equal(body.messages[2].tool_call_id, 'call_search_1');
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withUpstream(async (upstream) => {
        upstream.handler = (_req, res, body) => {
          item.assertBody(body as JsonObject);
          sendJson(res, 200, chatCompletion('llama', { role: 'assistant', content: 'ok' }, 'stop'));
        };

        const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
          method: 'POST',
          body: await fixture(item.fixture),
        });

        assert.equal(response.status, 200, await response.text());
      });
    });
  }
});

test('Spec 12 OpenAI Chat supports tool_choice none and parallel_tool_calls false', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res, body) => {
      assert.equal((body as JsonObject).tool_choice, 'none');
      assert.equal((body as JsonObject).parallel_tool_calls, false);
      sendJson(res, 200, chatCompletion('llama', { role: 'assistant', content: 'no tool needed' }, 'stop'));
    };

    const request = await fixture('openai-basic-tool.json');
    request.tool_choice = 'none';
    request.parallel_tool_calls = false;
    const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: request,
    });

    assert.equal(response.status, 200, await response.text());
  });
});

test('Spec 12 OpenAI Chat normalizes local-model tool-call output weirdness', async (t) => {
  const cases: Array<{
    name: string;
    message: JsonObject;
    assertMessage: (message: JsonObject) => void;
  }> = [
    {
      name: 'arguments as object and missing id',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: { location: 'Toronto' } } }],
      },
      assertMessage: (message) => {
        assert.equal(message.tool_calls[0].id, 'call_get_weather_0');
        assert.equal(message.tool_calls[0].function.arguments, '{"location":"Toronto"}');
      },
    },
    {
      name: 'arguments as stringified JSON',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Toronto"}' } }],
      },
      assertMessage: (message) => assert.equal(message.tool_calls[0].function.arguments, '{"location":"Toronto"}'),
    },
    {
      name: 'empty arguments object',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_empty_obj', type: 'function', function: { name: 'list_files', arguments: {} } }],
      },
      assertMessage: (message) => assert.equal(message.tool_calls[0].function.arguments, '{}'),
    },
    {
      name: 'empty arguments string',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_empty_string', type: 'function', function: { name: 'list_files', arguments: '' } }],
      },
      assertMessage: (message) => assert.equal(message.tool_calls[0].function.arguments, '{}'),
    },
    {
      name: 'multiple tool calls preserve ids and names',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_search', type: 'function', function: { name: 'search', arguments: '{"query":"relay"}' } },
          { id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
        ],
      },
      assertMessage: (message) => assert.deepEqual(message.tool_calls.map((call: JsonObject) => call.id), ['call_search', 'call_read']),
    },
    {
      name: 'assistant text plus tool call',
      message: {
        role: 'assistant',
        content: 'I will check that now.',
        tool_calls: [{ id: 'call_text_tool', type: 'function', function: { name: 'search', arguments: '{"query":"relay"}' } }],
      },
      assertMessage: (message) => {
        assert.equal(message.content, 'I will check that now.');
        assert.equal(message.tool_calls[0].function.name, 'search');
      },
    },
    {
      name: 'unknown tool name stays a normalized function call',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_unknown', type: 'function', function: { name: 'not_declared', arguments: '{"x":true}' } }],
      },
      assertMessage: (message) => assert.equal(message.tool_calls[0].function.name, 'not_declared'),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withUpstream(async (upstream) => {
        upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', item.message, 'tool_calls'));

        const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
          method: 'POST',
          body: await fixture('openai-basic-tool.json'),
        });

        const text = await response.text();
        assert.equal(response.status, 200, text);
        item.assertMessage(JSON.parse(text).choices[0].message);
      });
    });
  }
});

test('Spec 12 OpenAI Chat rejects unrepairable tool payloads cleanly', async (t) => {
  await t.test('invalid tool-call arguments from upstream', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'search', arguments: '{"query":' } }],
      }, 'tool_calls'));

      const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
        method: 'POST',
        body: await fixture('openai-basic-tool.json'),
      });

      await assertOpenAIError(response, 502);
    });
  });

  await t.test('missing upstream function name', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_bad', type: 'function', function: { arguments: '{}' } }],
      }, 'tool_calls'));

      const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
        method: 'POST',
        body: await fixture('openai-basic-tool.json'),
      });

      await assertOpenAIError(response, 502);
    });
  });

  await t.test('invalid request tool schema', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = () => assert.fail('invalid schema should not call upstream');
      const request = await fixture('openai-basic-tool.json');
      request.tools[0].function.parameters = 'not a schema object';

      const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
        method: 'POST',
        body: request,
      });

      await assertOpenAIError(response, 400);
    });
  });
});

test('Spec 12 Anthropic tool fixtures normalize through the supported Messages subset', async (t) => {
  const cases = [
    {
      name: 'tools and tool_choice auto',
      fixture: 'anthropic-basic-tool.json',
      assertBody: (body: JsonObject) => {
        assert.equal(body.tools[0].function.name, 'search');
        assert.equal(body.tool_choice, 'auto');
      },
    },
    {
      name: 'forced tool_choice by name',
      fixture: 'anthropic-forced-tool.json',
      assertBody: (body: JsonObject) => {
        assert.equal(body.tools[0].function.name, 'read_file');
        assert.equal(body.tool_choice.function.name, 'read_file');
      },
    },
    {
      name: 'assistant tool_use and multiple tool_result blocks',
      fixture: 'anthropic-tool-result-continuation.json',
      assertBody: (body: JsonObject) => {
        assert.equal(body.messages[0].tool_calls[0].id, 'toolu_search_1');
        assert.equal(body.messages[1].role, 'tool');
        assert.equal(body.messages[1].tool_call_id, 'toolu_search_1');
        assert.equal(body.messages[2].role, 'tool');
        assert.equal(body.messages[2].tool_call_id, 'toolu_search_2');
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      await withUpstream(async (upstream) => {
        upstream.handler = (_req, res, body) => {
          item.assertBody(body as JsonObject);
          sendJson(res, 200, chatCompletion('llama', { role: 'assistant', content: 'ok' }, 'stop'));
        };

        const response = await createApp(testConfig(upstream.url)).fetch('/v1/messages', {
          method: 'POST',
          body: await fixture(item.fixture),
        });

        assert.equal(response.status, 200, await response.text());
      });
    });
  }
});

test('Spec 12 Responses tool fixtures cover the supported function-tool subset', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res, body) => {
      assert.equal((body as JsonObject).tools[0].function.name, 'lookup');
      assert.equal((body as JsonObject).tool_choice, 'auto');
      sendJson(res, 200, chatCompletion('llama', {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"query":"Relay"}' } }],
      }, 'tool_calls'));
    };

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/responses', {
      method: 'POST',
      body: await fixture('responses-basic-tool.json'),
    });

    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    assert.deepEqual(body.output[0].content[0], {
      type: 'function_call',
      call_id: 'call_lookup',
      name: 'lookup',
      arguments: '{"query":"Relay"}',
    });
  });
});

test('Spec 12 Responses rejects hosted tools cleanly for the current implementation', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = () => assert.fail('hosted tool should not call upstream');
    const request = await fixture('responses-basic-tool.json');
    request.tools = [{ type: 'web_search_preview' }];

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/responses', {
      method: 'POST',
      body: request,
    });

    await assertOpenAIError(response, 400);
  });
});

async function fixture(name: string): Promise<JsonObject> {
  return JSON.parse(await readFile(join(fixtureDir, name), 'utf8'));
}

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
  };
}

async function withUpstream(run: (upstream: { url: string; handler: Handler }) => Promise<void>) {
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
    id: 'chatcmpl-tool-torture',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}

async function assertOpenAIError(response: Response, status: number) {
  const body = await response.json();
  assert.equal(response.status, status);
  assert.equal(typeof body.error.message, 'string');
  assert.doesNotMatch(body.error.message, /SyntaxError|stack/i);
}
