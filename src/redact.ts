const REDACTED = '[REDACTED]';

export function redactForLogs<T>(value: T): T {
  return redactValue(value) as T;
}

export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+([A-Za-z0-9._~+/=-]+)/gi, 'Bearer [REDACTED]')
    .replace(/(cf-access-client-id\s*[:=]\s*)([^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/(cf-access-client-secret\s*[:=]\s*)([^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/((?:openai|anthropic|relay)?_?api_?key\s*[:=]\s*)([^\s,;]+)/gi, `$1${REDACTED}`)
    .replace(/(cookie\s*[:=]\s*)([^\n]+)/gi, `$1${REDACTED}`);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === 'string') return redactText(value);
  if (!isObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => (
      isSensitiveKey(key)
        ? [key, REDACTED]
        : [key, redactValue(entry)]
    )),
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'authorization'
    || normalized === 'proxyauthorization'
    || normalized === 'cookie'
    || normalized === 'setcookie'
    || normalized.includes('apikey')
    || normalized.includes('cfaccessclientid')
    || normalized.includes('cfaccessclientsecret')
    || normalized.endsWith('clientsecret')
    || normalized === 'bearertoken'
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
