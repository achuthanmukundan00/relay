export type AppConfig = {
  port: number;
  host: string;
  upstreamBaseUrl: string;
  defaultModel?: string;
  samplingDefaults: SamplingDefaults;
  requestTimeoutMs: number;
  logLevel: string;
  apiKey?: string;
  completionTtlMs: number;
  upstreamVisionOk?: boolean;
  maxRequestBodyBytes: number;
  probeOnStartup: boolean;
  strictStartup: boolean;
  probeTimeoutMs: number;
  unknownFieldPolicy: UnknownFieldPolicy;
  strictCompat: boolean;
  warnOnStrippedFields: boolean;
};

export type UnknownFieldPolicy = 'pass_through' | 'strip' | 'reject';

export type SamplingDefaults = {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repeat_penalty?: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readInteger(env.PORT, 1234, 'PORT'),
    host: readString(env.HOST, '127.0.0.1'),
    upstreamBaseUrl: trimTrailingSlash(readString(env.UPSTREAM_BASE_URL, 'http://127.0.0.1:8080/v1')),
    defaultModel: readOptional(env.DEFAULT_MODEL),
    samplingDefaults: readSamplingDefaults(env),
    requestTimeoutMs: readInteger(env.REQUEST_TIMEOUT_SECONDS, 600, 'REQUEST_TIMEOUT_SECONDS') * 1000,
    logLevel: readString(env.LOG_LEVEL, 'info'),
    apiKey: readOptional(env.API_KEY),
    completionTtlMs: readInteger(env.COMPLETION_TTL_SECONDS, 3600, 'COMPLETION_TTL_SECONDS') * 1000,
    upstreamVisionOk: env.UPSTREAM_VISION_OK === 'true',
    maxRequestBodyBytes: readInteger(env.MAX_REQUEST_BODY_BYTES, 1_048_576, 'MAX_REQUEST_BODY_BYTES'),
    probeOnStartup: readBoolean(env.RELAY_PROBE_ON_STARTUP, true),
    strictStartup: readBoolean(env.RELAY_STRICT_STARTUP, false),
    probeTimeoutMs: readInteger(env.RELAY_PROBE_TIMEOUT_MS, 3000, 'RELAY_PROBE_TIMEOUT_MS'),
    unknownFieldPolicy: readUnknownFieldPolicy(env.RELAY_UNKNOWN_FIELD_POLICY),
    strictCompat: readBoolean(env.RELAY_STRICT_COMPAT, false),
    warnOnStrippedFields: readBoolean(env.RELAY_WARN_ON_STRIPPED_FIELDS, true),
  };
}

function readSamplingDefaults(env: NodeJS.ProcessEnv): SamplingDefaults {
  const defaults: SamplingDefaults = {};
  assignOptionalNumber(defaults, 'temperature', env.DEFAULT_TEMPERATURE, 'DEFAULT_TEMPERATURE');
  assignOptionalNumber(defaults, 'top_p', env.DEFAULT_TOP_P, 'DEFAULT_TOP_P');
  assignOptionalNumber(defaults, 'top_k', env.DEFAULT_TOP_K, 'DEFAULT_TOP_K');
  assignOptionalNumber(defaults, 'min_p', env.DEFAULT_MIN_P, 'DEFAULT_MIN_P');
  assignOptionalNumber(defaults, 'presence_penalty', env.DEFAULT_PRESENCE_PENALTY, 'DEFAULT_PRESENCE_PENALTY');
  assignOptionalNumber(defaults, 'repeat_penalty', env.DEFAULT_REPETITION_PENALTY, 'DEFAULT_REPETITION_PENALTY');
  return defaults;
}

function assignOptionalNumber<T extends keyof SamplingDefaults>(
  defaults: SamplingDefaults,
  key: T,
  value: string | undefined,
  name: string,
): void {
  const parsed = readOptionalNumber(value, name);
  if (parsed !== undefined) defaults[key] = parsed;
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

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const raw = readOptional(value);
  if (!raw) return fallback;
  return raw.toLowerCase() === 'true';
}

function readUnknownFieldPolicy(value: string | undefined): UnknownFieldPolicy {
  const raw = readOptional(value) ?? 'pass_through';
  if (raw === 'pass_through' || raw === 'strip' || raw === 'reject') return raw;
  throw new Error('RELAY_UNKNOWN_FIELD_POLICY must be pass_through, strip, or reject');
}

function readOptionalNumber(value: string | undefined, name: string): number | undefined {
  const raw = readOptional(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
