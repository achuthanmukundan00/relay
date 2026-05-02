import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig } from '../../src/config.ts';
import { createApp } from '../../src/server.ts';

type JsonObject = Record<string, any>;

export type FailureScenario = {
  name: string;
  mode?: 'classification-only';
  path?: string;
  method?: string;
  body_fixture?: string;
  upstream_fixture?: UpstreamFixtureName;
  api_key?: string;
  expected_status?: number;
  expected_error_type?: string;
  expected_error_code?: string;
  expected_classification: string;
  expected_upstream_status?: number;
  error_type?: string;
  error_code?: string;
  http_status?: number;
};

export type UpstreamFixtureName =
  | 'empty-response'
  | 'malformed-json'
  | 'broken-sse-chunk'
  | 'timeout'
  | 'unsupported-tool-call-shape'
  | 'non-openai-compatible-error';

export async function loadFailureScenarios(): Promise<FailureScenario[]> {
  return readJsonFixture('scenarios.json');
}

export async function loadJsonFixture<T>(name: string): Promise<T> {
  return readJsonFixture(name);
}

export async function loadTextFixture(name: string): Promise<string> {
  return readFile(fixturePath(name), 'utf8');
}

export function createTestConfig(upstreamBaseUrl: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8080,
    host: '127.0.0.1',
    upstreamBaseUrl,
    samplingDefaults: {},
    requestTimeoutMs: 50,
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
    ...overrides,
  };
}

export async function withMockUpstream<T>(run: (upstream: { url: string; handler: Handler }) => Promise<T>): Promise<T> {
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
    return await run(upstream);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

export async function attachUpstreamFixture(upstream: { handler: Handler }, name: UpstreamFixtureName): Promise<void> {
  if (name === 'timeout') {
    upstream.handler = async () => {
      await sleep(200);
    };
    return;
  }

  if (name === 'empty-response') {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('');
    };
    return;
  }

  if (name === 'malformed-json') {
    const body = await loadTextFixture('upstream-malformed-json.txt');
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    };
    return;
  }

  if (name === 'broken-sse-chunk') {
    const body = await loadTextFixture('upstream-broken-sse-chunk.txt');
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    };
    return;
  }

  if (name === 'unsupported-tool-call-shape') {
    const payload = await loadJsonFixture<JsonObject>('upstream-unsupported-tool-call-shape.json');
    upstream.handler = (_req, res) => sendJson(res, 200, payload);
    return;
  }

  if (name === 'non-openai-compatible-error') {
    const text = await loadTextFixture('upstream-non-openai-compatible-error.txt');
    upstream.handler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end(text);
    };
    return;
  }

  assert.fail(`unknown upstream fixture: ${name}`);
}

export async function runFailureScenario(scenario: FailureScenario): Promise<{
  response: Response | null;
  body: any;
  observed: any;
}> {
  if (scenario.mode === 'classification-only') {
    return { response: null, body: null, observed: null };
  }

  return withMockUpstream(async (upstream) => {
    if (scenario.upstream_fixture) await attachUpstreamFixture(upstream, scenario.upstream_fixture);
    else upstream.handler = (_req, res) => sendJson(res, 200, okCompletion());

    const app = createApp(createTestConfig(upstream.url, {
      apiKey: scenario.api_key,
      requestTimeoutMs: scenario.upstream_fixture === 'timeout' ? 10 : 50,
    }));
    const body = scenario.body_fixture ? await loadJsonFixture<JsonObject>(scenario.body_fixture) : undefined;
    const headers: Record<string, string> = { 'user-agent': `relay-degraded/${scenario.name}` };
    const response = await app.fetch(scenario.path!, {
      method: scenario.method,
      headers,
      body,
    });
    const parsed = await parseResponse(response);
    const requests = await app.fetch('/relay/requests', {
      headers: scenario.api_key ? { authorization: `Bearer ${scenario.api_key}` } : undefined,
    });
    const observedList = await requests.json();
    const observed = observedList.data.find((entry: any) => entry.request_id === response.headers.get('x-relay-request-id'));
    return { response, body: parsed, observed };
  });
}

function fixturePath(name: string): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dirname, '../fixtures/degraded', name);
}

async function readJsonFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(fixturePath(name), 'utf8')) as T;
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

function okCompletion(): JsonObject {
  return {
    id: 'chatcmpl-ok',
    object: 'chat.completion',
    created: 1,
    model: 'llama',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}

async function parseResponse(response: Response): Promise<any> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
