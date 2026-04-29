import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.ts';

test('loads spec defaults', () => {
  const config = loadConfig({});

  assert.equal(config.port, 1234);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.upstreamBaseUrl, 'http://127.0.0.1:8080');
  assert.equal(config.defaultModel, undefined);
  assert.equal(config.requestTimeoutMs, 600_000);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.apiKey, undefined);
  assert.equal(config.maxRequestBodyBytes, 1_048_576);
});

test('loads overrides from environment', () => {
  const config = loadConfig({
    PORT: '9090',
    HOST: '0.0.0.0',
    UPSTREAM_BASE_URL: 'http://llama.local:8080/',
    DEFAULT_MODEL: 'local-model',
    REQUEST_TIMEOUT_SECONDS: '12',
    LOG_LEVEL: 'debug',
    API_KEY: 'secret',
    MAX_REQUEST_BODY_BYTES: '4096',
  });

  assert.equal(config.port, 9090);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.upstreamBaseUrl, 'http://llama.local:8080');
  assert.equal(config.defaultModel, 'local-model');
  assert.equal(config.requestTimeoutMs, 12_000);
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.apiKey, 'secret');
  assert.equal(config.maxRequestBodyBytes, 4096);
});
