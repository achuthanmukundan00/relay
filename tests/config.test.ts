import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.ts';

test('loads spec defaults', () => {
  const config = loadConfig({});

  assert.equal(config.port, 1234);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.upstreamBaseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(config.defaultModel, undefined);
  assert.deepEqual(config.samplingDefaults, {});
  assert.equal(config.requestTimeoutMs, 600_000);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.apiKey, undefined);
  assert.equal(config.maxRequestBodyBytes, 1_048_576);
  assert.equal(config.probeOnStartup, true);
  assert.equal(config.strictStartup, false);
  assert.equal(config.probeTimeoutMs, 3000);
  assert.equal(config.unknownFieldPolicy, 'pass_through');
  assert.equal(config.strictCompat, false);
  assert.equal(config.warnOnStrippedFields, true);
});

test('loads overrides from environment', () => {
  const config = loadConfig({
    PORT: '9090',
    HOST: '0.0.0.0',
    UPSTREAM_BASE_URL: 'http://llama.local:8080/',
    DEFAULT_MODEL: 'local-model',
    DEFAULT_TEMPERATURE: '1.0',
    DEFAULT_TOP_P: '0.95',
    DEFAULT_TOP_K: '20',
    DEFAULT_MIN_P: '0.0',
    DEFAULT_PRESENCE_PENALTY: '1.5',
    DEFAULT_REPETITION_PENALTY: '1.0',
    REQUEST_TIMEOUT_SECONDS: '12',
    LOG_LEVEL: 'debug',
    API_KEY: 'secret',
    MAX_REQUEST_BODY_BYTES: '4096',
    RELAY_PROBE_ON_STARTUP: 'false',
    RELAY_STRICT_STARTUP: 'true',
    RELAY_PROBE_TIMEOUT_MS: '50',
    RELAY_UNKNOWN_FIELD_POLICY: 'reject',
    RELAY_STRICT_COMPAT: 'true',
    RELAY_WARN_ON_STRIPPED_FIELDS: 'false',
  });

  assert.equal(config.port, 9090);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.upstreamBaseUrl, 'http://llama.local:8080');
  assert.equal(config.defaultModel, 'local-model');
  assert.deepEqual(config.samplingDefaults, {
    temperature: 1.0,
    top_p: 0.95,
    top_k: 20,
    min_p: 0.0,
    presence_penalty: 1.5,
    repeat_penalty: 1.0,
  });
  assert.equal(config.requestTimeoutMs, 12_000);
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.apiKey, 'secret');
  assert.equal(config.maxRequestBodyBytes, 4096);
  assert.equal(config.probeOnStartup, false);
  assert.equal(config.strictStartup, true);
  assert.equal(config.probeTimeoutMs, 50);
  assert.equal(config.unknownFieldPolicy, 'reject');
  assert.equal(config.strictCompat, true);
  assert.equal(config.warnOnStrippedFields, false);
});
