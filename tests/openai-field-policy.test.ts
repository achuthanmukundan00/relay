import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

test('OpenAI chat unknown fields pass through by default', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.equal((body as any).llama_extra, true);
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };

    const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'llama',
        messages: [{ role: 'user', content: 'hi' }],
        llama_extra: true,
      },
    });

    assert.equal(response.status, 200, await response.text());
  });
});

test('OpenAI chat unknown fields strip with warning when configured', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = async (_req, res, body) => {
      assert.equal('llama_extra' in (body as any), false);
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };

    const response = await createApp({ ...testConfig(upstream.url), unknownFieldPolicy: 'strip' }).fetch('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'llama',
        messages: [{ role: 'user', content: 'hi' }],
        llama_extra: true,
      },
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(response.headers.get('x-relay-warning'), 'stripped_unsupported_fields');
  });
});

test('OpenAI chat unknown fields reject when configured', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = () => assert.fail('rejected field should not hit upstream');

    const response = await createApp({ ...testConfig(upstream.url), unknownFieldPolicy: 'reject' }).fetch('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'llama',
        messages: [{ role: 'user', content: 'hi' }],
        llama_extra: true,
      },
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, /llama_extra/);
  });
});

test('OpenAI hosted-only fields strip by default and reject in strict compat mode', async (t) => {
  await t.test('strip by default', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = async (_req, res, body) => {
        assert.equal('web_search_options' in (body as any), false);
        sendJson(res, 200, chatCompletion('llama', 'ok'));
      };

      const response = await createApp(testConfig(upstream.url)).fetch('/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'llama',
          messages: [{ role: 'user', content: 'hi' }],
          web_search_options: { search_context_size: 'low' },
        },
      });

      assert.equal(response.status, 200, await response.text());
      assert.equal(response.headers.get('x-relay-warning'), 'stripped_unsupported_fields');
    });
  });

  await t.test('reject in strict compat mode', async () => {
    await withUpstream(async (upstream) => {
      upstream.handler = () => assert.fail('strict compat rejection should not hit upstream');

      const response = await createApp({ ...testConfig(upstream.url), strictCompat: true }).fetch('/v1/chat/completions', {
        method: 'POST',
        body: {
          model: 'llama',
          messages: [{ role: 'user', content: 'hi' }],
          web_search_options: { search_context_size: 'low' },
        },
      });

      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.type, 'unsupported_capability');
      assert.equal(body.error.code, 'unsupported_capability');
    });
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

function chatCompletion(model: string, content: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
