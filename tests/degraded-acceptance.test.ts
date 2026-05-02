import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFailure } from '../src/observability.ts';
import {
  attachUpstreamFixture,
  createTestConfig,
  loadFailureScenarios,
  loadJsonFixture,
  withMockUpstream,
} from './helpers/degraded-harness.ts';
import { createApp } from '../src/server.ts';

test('fixture-based degraded acceptance scenarios classify each failure bucket', async () => {
  const scenarios = await loadFailureScenarios();

  for (const scenario of scenarios) {
    await test(scenario.name, async () => {
      if (scenario.mode === 'classification-only') {
        assert.equal(
          classifyFailure(scenario.error_type, scenario.error_code, scenario.http_status),
          scenario.expected_classification,
        );
        return;
      }

      await withMockUpstream(async (upstream) => {
        if (scenario.upstream_fixture) await attachUpstreamFixture(upstream, scenario.upstream_fixture);
        else upstream.handler = (_req, res) => {
          res.end('');
        };

        const app = createApp(createTestConfig(upstream.url, {
          apiKey: scenario.api_key,
          requestTimeoutMs: scenario.upstream_fixture === 'timeout' ? 10 : 50,
        }));
        const response = await app.fetch(scenario.path!, {
          method: scenario.method,
          headers: { 'user-agent': `relay-fixture/${scenario.name}` },
          body: scenario.body_fixture ? await loadJsonFixture(scenario.body_fixture) : undefined,
        });

        assert.equal(response.status, scenario.expected_status);
        const body = await response.json();
        assert.equal(body.error.type, scenario.expected_error_type);
        assert.equal(body.error.code, scenario.expected_error_code);

        const requests = await app.fetch('/relay/requests', {
          headers: scenario.api_key ? { authorization: `Bearer ${scenario.api_key}` } : undefined,
        });
        const requestLog = await requests.json();
        const observed = requestLog.data.find((entry: any) => entry.request_id === response.headers.get('x-relay-request-id'));
        assert.ok(observed);
        assert.equal(observed.endpoint, scenario.path);
        assert.equal(observed.client, `relay-fixture/${scenario.name}`);
        assert.equal(observed.model_profile, 'generic');
        assert.equal(observed.failure_classification, scenario.expected_classification);
        assert.equal(observed.request.headers['user-agent'], `relay-fixture/${scenario.name}`);
        assert.doesNotMatch(JSON.stringify(observed.request.headers), /secret|Bearer\s+[A-Za-z0-9._~+/=-]+/);
        assert.equal(observed.upstream_status ?? null, scenario.expected_upstream_status ?? null);
        assert.equal(observed.response.upstream_status ?? null, scenario.expected_upstream_status ?? null);
      });
    });
  }
});

test('synthetic upstream fixtures cover degraded empty, malformed, streaming, timeout, tool-shape, and non-openai errors', async () => {
  const standard = await loadJsonFixture<Record<string, unknown>>('standard-chat-request.json');

  await withMockUpstream(async (upstream) => {
    await attachUpstreamFixture(upstream, 'empty-response');
    const response = await createApp(createTestConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'user-agent': 'relay-fixture/empty-response' },
      body: standard,
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'upstream_bad_response');
  });

  await withMockUpstream(async (upstream) => {
    await attachUpstreamFixture(upstream, 'malformed-json');
    const response = await createApp(createTestConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: standard,
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'upstream_bad_response');
  });

  await withMockUpstream(async (upstream) => {
    await attachUpstreamFixture(upstream, 'broken-sse-chunk');
    const response = await createApp(createTestConfig(upstream.url)).fetch('/v1/responses', {
      method: 'POST',
      body: { model: 'llama', input: 'Say OK', stream: true },
    });
    const text = await response.text();
    assert.match(text, /event: response\.failed/);
  });

  await withMockUpstream(async (upstream) => {
    await attachUpstreamFixture(upstream, 'timeout');
    const response = await createApp(createTestConfig(upstream.url, { requestTimeoutMs: 10 })).fetch('/v1/chat/completions', {
      method: 'POST',
      body: standard,
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'upstream_timeout');
  });

  await withMockUpstream(async (upstream) => {
    await attachUpstreamFixture(upstream, 'unsupported-tool-call-shape');
    const response = await createApp(createTestConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: standard,
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'upstream_bad_response');
  });

  await withMockUpstream(async (upstream) => {
    await attachUpstreamFixture(upstream, 'non-openai-compatible-error');
    const response = await createApp(createTestConfig(upstream.url)).fetch('/v1/chat/completions', {
      method: 'POST',
      body: standard,
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'upstream_unavailable');
    assert.equal(response.headers.get('x-relay-upstream-status'), '503');
  });
});
