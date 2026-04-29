export type AppConfig = {
  port: number;
  host: string;
  upstreamBaseUrl: string;
  defaultModel?: string;
  requestTimeoutMs: number;
  logLevel: string;
  apiKey?: string;
  completionTtlMs: number;
  upstreamVisionOk?: boolean;
  maxRequestBodyBytes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readInteger(env.PORT, 1234, 'PORT'),
    host: readString(env.HOST, '127.0.0.1'),
    upstreamBaseUrl: trimTrailingSlash(readString(env.UPSTREAM_BASE_URL, 'http://127.0.0.1:8080')),
    defaultModel: readOptional(env.DEFAULT_MODEL),
    requestTimeoutMs: readInteger(env.REQUEST_TIMEOUT_SECONDS, 600, 'REQUEST_TIMEOUT_SECONDS') * 1000,
    logLevel: readString(env.LOG_LEVEL, 'info'),
    apiKey: readOptional(env.API_KEY),
    completionTtlMs: readInteger(env.COMPLETION_TTL_SECONDS, 3600, 'COMPLETION_TTL_SECONDS') * 1000,
    upstreamVisionOk: env.UPSTREAM_VISION_OK === 'true',
    maxRequestBodyBytes: readInteger(env.MAX_REQUEST_BODY_BYTES, 1_048_576, 'MAX_REQUEST_BODY_BYTES'),
  };
}

function readOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readString(value: string | undefined, fallback: string): string {
  return readOptional(value) ?? fallback;
}

function readInteger(value: string | undefined, fallback: number, name: string): number {
  const raw = readOptional(value);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
