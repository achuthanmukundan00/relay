const base = (process.env.RELAY_BASE_URL ?? 'http://127.0.0.1:1234').replace(/\/+$/, '');
const model = process.env.MODEL ?? process.env.DEFAULT_MODEL ?? 'local-model';

await checkHealth();
await checkChat();
console.log('PASS smoke:openai');

async function checkHealth(): Promise<void> {
  const res = await fetch(`${base}/health`);
  if (!res.ok) fail(`/health returned HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body?.ok !== true) fail('/health did not return ok=true');
}

async function checkChat(): Promise<void> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with OK' }],
      max_tokens: 16,
    }),
  });

  const raw = await res.text();
  if (!res.ok) fail(`/v1/chat/completions HTTP ${res.status}: ${short(raw)}`);

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    fail('/v1/chat/completions returned non-JSON response');
  }

  if (!Array.isArray(body?.choices) || body.choices.length === 0) {
    fail('/v1/chat/completions response missing choices');
  }
}

function short(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function fail(message: string): never {
  console.error(`FAIL smoke:openai - ${message}`);
  process.exit(1);
}
