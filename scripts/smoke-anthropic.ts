const base = (process.env.RELAY_BASE_URL ?? 'http://127.0.0.1:1234').replace(/\/+$/, '');
const model = process.env.MODEL ?? process.env.DEFAULT_MODEL ?? 'local-model';

await checkHealth();
await checkMessages();
console.log('PASS smoke:anthropic');

async function checkHealth(): Promise<void> {
  const res = await fetch(`${base}/health`);
  if (!res.ok) fail(`/health returned HTTP ${res.status}`);
}

async function checkMessages(): Promise<void> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': process.env.ANTHROPIC_VERSION ?? '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with OK' }],
    }),
  });

  const raw = await res.text();
  if (!res.ok) fail(`/v1/messages HTTP ${res.status}: ${short(raw)}`);

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    fail('/v1/messages returned non-JSON response');
  }

  if (!body || typeof body !== 'object' || body.type !== 'message') {
    fail('/v1/messages response missing type=message');
  }
}

function short(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function fail(message: string): never {
  console.error(`FAIL smoke:anthropic - ${message}`);
  process.exit(1);
}
