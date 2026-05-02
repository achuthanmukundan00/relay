import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import { loadConfig, type AppConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';

test('profile config defaults to generic and validates allowed values', () => {
  const config = loadConfig({});
  assert.equal(config.modelProfile, 'generic');
  assert.equal(config.reasoningMode, 'off');
  assert.equal(config.toolMode, 'auto');

  assert.throws(() => loadConfig({ RELAY_MODEL_PROFILE: 'unknown' }), /RELAY_MODEL_PROFILE/);
  assert.throws(() => loadConfig({ RELAY_REASONING_MODE: 'weird' }), /RELAY_REASONING_MODE/);
  assert.throws(() => loadConfig({ RELAY_TOOL_MODE: 'weird' }), /RELAY_TOOL_MODE/);
});

test('capabilities expose the active model profile and relay headers include it', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', 'ok'));
    const app = createApp({ ...testConfig(upstream.url), modelProfile: 'qwen' });

    const capabilities = await app.fetch('/relay/capabilities');
    assert.equal(capabilities.status, 200);
    assert.deepEqual((await capabilities.json()).profile, {
      id: 'qwen',
      name: 'Qwen',
      reasoningMode: 'off',
      toolMode: 'auto',
      expectedContext: {
        recommended: '16k debug profile, then 32k+ only when first-token latency is acceptable',
        ceiling: '90k+ is possible but can cause multi-minute prefill on consumer hardware',
        notes: 'Designed for local coding-agent use where a shorter debug context is safer than maximum window size.',
      },
      recommendedSampling: {
        temperature: 0.6,
      },
      knownClientCompatibility: [
        'Cline chat streaming and XML attempt-completion flow are the most concrete local-agent evidence in this repo.',
        'OpenCode chat/tool injection path has a verified smoke helper but not a full autonomous edit-loop proof.',
      ],
      knownFailureModes: [
        'Large prompts plus large context windows can look frozen while llama.cpp is still in prefill.',
        'Lower-quant local variants may emit malformed or incomplete tool/protocol output under long agent loops.',
      ],
      recommendedAgentWorkflow: [
        'Keep prompts short and ask for one patch at a time.',
        'Force inspect-before-edit and prefer exact file targets.',
        'Use bounded retries and one verification command.',
      ],
    });

    const response = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(response.headers.get('x-relay-model-profile'), 'qwen');
  });
});

test('profile sampling defaults apply only when the request does not set the field explicitly', async () => {
  await withUpstream(async (upstream) => {
    const temperatures: number[] = [];
    upstream.handler = async (_req, res, body) => {
      temperatures.push((body as any).temperature);
      sendJson(res, 200, chatCompletion('llama', 'ok'));
    };
    const app = createApp({ ...testConfig(upstream.url), modelProfile: 'qwen' });

    const inherited = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(inherited.status, 200);

    const explicit = await app.fetch('/v1/chat/completions', {
      method: 'POST',
      body: { model: 'llama', temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(explicit.status, 200);

    assert.equal(temperatures[0], 0.6);
    assert.equal(temperatures[1], 0.2);
  });
});

test('configured sampling defaults are reflected in the exposed profile recommendations', async () => {
  await withUpstream(async (upstream) => {
    upstream.handler = (_req, res) => sendJson(res, 200, chatCompletion('llama', 'ok'));
    const app = createApp({
      ...testConfig(upstream.url),
      modelProfile: 'qwen',
      samplingDefaults: { top_p: 0.9 },
    });

    const capabilities = await app.fetch('/relay/capabilities');
    assert.equal(capabilities.status, 200);
    const body = await capabilities.json();
    assert.deepEqual(body.profile.recommendedSampling, {
      temperature: 0.6,
      top_p: 0.9,
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
    id: 'chatcmpl-profile',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
