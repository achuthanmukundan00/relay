import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { createApp } from '../src/server.ts';
import type { AppConfig } from '../src/config.ts';
import { openAIMessageToAnthropicContent } from '../src/normalize/tools.ts';

test('OpenAI tool calls receive stable ids and JSON string arguments', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      sendJson(res, 200, {
        id: 'chatcmpl-tools',
        object: 'chat.completion',
        created: 1,
        model: 'llama',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              type: 'function',
              function: { name: 'lookup', arguments: { query: 'relay' } },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      });
    };

    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'llama',
        messages: [{ role: 'user', content: 'search' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      },
    });

    const text = await res.text();
    assert.equal(res.status, 200, text);
    const json = JSON.parse(text);
    const toolCall = json.choices[0].message.tool_calls[0];
    assert.equal(toolCall.id, 'call_lookup_0');
    assert.equal(toolCall.type, 'function');
    assert.equal(toolCall.function.arguments, '{"query":"relay"}');
  });
});

test('malformed OpenAI tool arguments return a clean gateway error', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => {
      sendJson(res, 200, {
        id: 'chatcmpl-bad-tools',
        object: 'chat.completion',
        created: 1,
        model: 'llama',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_bad',
              type: 'function',
              function: { name: 'lookup', arguments: '{"query":' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      });
    };

    const res = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'user', content: 'search' }] },
    });

    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(typeof body.error.message, 'string');
    assert.doesNotMatch(body.error.message, /SyntaxError|stack/i);
  });
});

test('OpenAI assistant tool calls convert to Anthropic tool_use blocks with parsed input', () => {
  const content = openAIMessageToAnthropicContent({
    role: 'assistant',
    content: 'I will search.',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"query":"relay"}' },
    }],
  });

  assert.deepEqual(content, [
    { type: 'text', text: 'I will search.' },
    { type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'relay' } },
  ]);
});

test('Anthropic conversion rejects malformed tool argument JSON', () => {
  assert.throws(() => openAIMessageToAnthropicContent({
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"query":' },
    }],
  }), /Invalid tool call arguments/);
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

async function withUpstream(run: (upstream: { url: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) => Promise<void>) {
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

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
