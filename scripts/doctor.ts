import { loadConfig } from '../src/config.ts';
import { parseSSEJson, parseSSEStream } from '../src/normalize/stream.ts';
import { redactForLogs, redactText } from '../src/redact.ts';

type Status = 'PASS' | 'FAIL' | 'SKIP';
type Row = { name: string; status: Status; detail: string };

const config = loadConfig();
const relayBaseUrl = (process.env.RELAY_BASE_URL ?? `http://${config.host}:${config.port}`).replace(/\/+$/, '');
const upstreamApiBaseUrl = config.upstreamBaseUrl.replace(/\/+$/, '');
const upstreamRootUrl = upstreamApiBaseUrl.replace(/\/v1$/, '');
const rows: Row[] = [];

const envModel = process.env.MODEL ?? process.env.DEFAULT_MODEL ?? config.defaultModel;
rows.push({
  name: 'relay env',
  status: 'PASS',
  detail: shorten(JSON.stringify(redactForLogs({
    relay_base_url: relayBaseUrl,
    upstream_base_url: upstreamApiBaseUrl,
    model: envModel ?? 'auto',
    api_key: process.env.RELAY_API_KEY ?? process.env.API_KEY ? 'configured' : 'unset',
    cf_access_client_id: process.env.CF_ACCESS_CLIENT_ID ? 'configured' : 'unset',
    cf_access_client_secret: process.env.CF_ACCESS_CLIENT_SECRET ? 'configured' : 'unset',
    relay_cookie: process.env.RELAY_COOKIE ? 'configured' : 'unset',
  }))),
});

await checkJson('relay health', `${relayBaseUrl}/health`, undefined, (body) => `ok=${body?.ok === true}`);
const capabilities = await checkJson('relay capabilities', `${relayBaseUrl}/relay/capabilities`, {
  headers: relayHeaders(),
}, (body) => `reachable=${body?.upstream?.reachable ?? 'unknown'}`);
await checkJson('upstream health', `${upstreamRootUrl}/health`, undefined, (_body, response) => `HTTP ${response.status}`, true);
const upstreamModels = await checkJson('upstream models', `${upstreamApiBaseUrl}/models`, undefined, (body) => `models=${Array.isArray(body?.data) ? body.data.length : 0}`, true);

const model = envModel
  ?? firstModel(upstreamModels.body)
  ?? firstModel((await checkJson('relay models', `${relayBaseUrl}/v1/models`, { headers: relayHeaders() }, (body) => `models=${Array.isArray(body?.data) ? body.data.length : 0}`)).body);

if (!model) {
  rows.push({ name: 'model selection', status: 'FAIL', detail: 'Set MODEL or expose /v1/models' });
} else {
  await checkOpenAIChat('openai chat', model);
  await checkOpenAIStream('openai chat stream', model);
  const anthropicStatus = capabilities.body?.endpoints?.anthropicMessages;
  if (anthropicStatus === 'unsupported') {
    rows.push({ name: 'anthropic messages', status: 'SKIP', detail: 'Relay reports endpoint unsupported' });
  } else {
    await checkAnthropicChat('anthropic messages', model);
  }
}

printRows(rows);
if (rows.some((row) => row.status === 'FAIL')) process.exit(1);

async function checkJson(
  name: string,
  url: string,
  init: RequestInit | undefined,
  summarize: (body: any, response: Response) => string,
  optional = false,
): Promise<{ body: any }> {
  try {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (optional && (response.status === 404 || response.status === 501)) {
        rows.push({ name, status: 'SKIP', detail: `HTTP ${response.status}` });
        return { body };
      }
      rows.push({ name, status: 'FAIL', detail: `HTTP ${response.status} ${summarizeFailure(body)}` });
      return { body };
    }
    rows.push({ name, status: 'PASS', detail: summarize(body, response) });
    return { body };
  } catch (error) {
    rows.push({ name, status: optional ? 'SKIP' : 'FAIL', detail: summarizeError(error) });
    return { body: undefined };
  }
}

async function checkOpenAIChat(name: string, model: string): Promise<void> {
  try {
    const response = await fetch(`${relayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...relayHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OK' }],
        max_tokens: 16,
      }),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      rows.push({ name, status: 'FAIL', detail: `HTTP ${response.status} ${summarizeFailure(body)}` });
      return;
    }
    rows.push({ name, status: 'PASS', detail: `id=${body?.id ?? 'missing'} request_id=${response.headers.get('x-relay-request-id') ?? 'missing'}` });
  } catch (error) {
    rows.push({ name, status: 'FAIL', detail: summarizeError(error) });
  }
}

async function checkOpenAIStream(name: string, model: string): Promise<void> {
  try {
    const response = await fetch(`${relayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...relayHeaders(),
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OK' }],
        max_tokens: 16,
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      rows.push({ name, status: 'FAIL', detail: `HTTP ${response.status} ${summarizeFailure(body)}` });
      return;
    }

    let frames = 0;
    let sawDone = false;
    for await (const frame of parseSSEStream(response.body)) {
      if (frame.data === '[DONE]') {
        sawDone = true;
        continue;
      }
      parseSSEJson(frame);
      frames += 1;
    }

    if (frames === 0 || !sawDone) {
      rows.push({ name, status: 'FAIL', detail: `frames=${frames} done=${sawDone}` });
      return;
    }
    rows.push({ name, status: 'PASS', detail: `frames=${frames} done=${sawDone}` });
  } catch (error) {
    rows.push({ name, status: 'FAIL', detail: summarizeError(error) });
  }
}

async function checkAnthropicChat(name: string, model: string): Promise<void> {
  try {
    const response = await fetch(`${relayBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        ...relayHeaders(),
        'content-type': 'application/json',
        'anthropic-version': process.env.ANTHROPIC_VERSION ?? '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with OK' }],
      }),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 404 || summarizeFailure(body).toLowerCase().includes('not supported')) {
        rows.push({ name, status: 'SKIP', detail: summarizeFailure(body) });
        return;
      }
      rows.push({ name, status: 'FAIL', detail: `HTTP ${response.status} ${summarizeFailure(body)}` });
      return;
    }
    rows.push({ name, status: 'PASS', detail: `type=${body?.type ?? 'unknown'} stop=${body?.stop_reason ?? 'unknown'}` });
  } catch (error) {
    rows.push({ name, status: 'FAIL', detail: summarizeError(error) });
  }
}

function relayHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.RELAY_API_KEY ?? process.env.API_KEY;
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }
  if (process.env.CF_ACCESS_CLIENT_ID) headers['cf-access-client-id'] = process.env.CF_ACCESS_CLIENT_ID;
  if (process.env.CF_ACCESS_CLIENT_SECRET) headers['cf-access-client-secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
  if (process.env.RELAY_COOKIE) headers.cookie = process.env.RELAY_COOKIE;
  return headers;
}

function firstModel(body: any): string | undefined {
  return Array.isArray(body?.data) ? body.data.find((item: any) => typeof item?.id === 'string')?.id : undefined;
}

function summarizeFailure(body: unknown): string {
  if (typeof body === 'string') return shorten(body);
  if (body && typeof body === 'object') return shorten(JSON.stringify(redactForLogs(body)));
  return 'request failed';
}

function summarizeError(error: unknown): string {
  return shorten(error instanceof Error ? error.message : String(error));
}

function shorten(value: string): string {
  return redactText(value).replace(/\s+/g, ' ').trim().slice(0, 160) || 'request failed';
}

function printRows(items: Row[]): void {
  const width = Math.max(...items.map((item) => item.name.length), 0);
  for (const item of items) {
    console.log(`${item.status.padEnd(4)} ${item.name.padEnd(width)}  ${item.detail}`);
  }
}
