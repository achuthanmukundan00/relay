# Relay

[![License](https://img.shields.io/github/license/achuthanmukundan00/relay)](https://github.com/achuthanmukundan00/relay/blob/main/LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/achuthanmukundan00/relay)](https://github.com/achuthanmukundan00/relay/releases/latest)
[![Docs Workflow](https://img.shields.io/github/actions/workflow/status/achuthanmukundan00/relay/docs.yml?label=docs)](https://github.com/achuthanmukundan00/relay/actions/workflows/docs.yml)
[![Docs](https://img.shields.io/badge/docs-site-blue)](https://achuthanmukundan00.github.io/relay/)

Relay is a lightweight, agent-focused gateway that makes local LLM servers look like hosted OpenAI- and Anthropic-style APIs.

It sits between clients and a local upstream model server (like `llama.cpp`), normalizes request/response shapes, and preserves practical compatibility for tools that expect modern API conventions.

- Docs site: `https://achuthanmukundan00.github.io/relay/`
- Latest release: `https://github.com/achuthanmukundan00/relay/releases/latest`
- Current release tag (`v0.1.1`): `https://github.com/achuthanmukundan00/relay/releases/tag/v0.1.1`

## Why Relay Exists

Local model servers are fast and private, but many agent clients are built around hosted API contracts. Relay closes that gap so local models can work with existing OpenAI/Anthropic-compatible tooling without rewriting each client.

## Key Capabilities

- OpenAI-compatible endpoints for chat, responses, completions, embeddings, and model listing
- Anthropic-compatible messages endpoint
- Streaming compatibility and SSE normalization/repair
- Request/response canonicalization across protocol variants
- Lightweight observability endpoints for health, capabilities, and recent request stats
- Configurable strictness for unknown/hosted-only fields

## Supported APIs

Relay currently supports practical compatibility for:

- OpenAI-style: [`/v1/chat/completions`](https://developers.openai.com/api/reference/chat-completions/overview), [`/v1/completions`](https://platform.openai.com/docs/api-reference/completions/create), [`/v1/responses`](https://platform.openai.com/docs/api-reference/responses/create), [`/v1/embeddings`](https://platform.openai.com/docs/api-reference/embeddings/create), [`/v1/models`](https://platform.openai.com/docs/api-reference/models/list)
- Anthropic-style: [`/v1/messages`](https://platform.claude.com/docs/en/api/messages), [`/v1/messages/count_tokens`](https://platform.claude.com/docs/en/api/messages/count_tokens)
- Utility: `/health`, `/relay/capabilities`, `/relay/stats`, `/relay/requests`

## Non-Goals

Relay does not currently implement full hosted feature parity, including:

- Assistants/Threads/Runs-style orchestration APIs
- Realtime APIs
- Image/audio/file APIs
- Hosted vendor control-plane features

## Quickstart (5 Minutes)

1. Start a local upstream model server (example: `llama.cpp`):

```bash
llama-server --model /path/to/model.gguf --host 127.0.0.1 --port 8080
```

2. Install and configure Relay:

```bash
npm install
cp .env.example .env
```

3. Start Relay:

```bash
npm run dev
```

4. Verify health:

```bash
curl http://127.0.0.1:1234/health
```

5. Run smoke checks:

```bash
npm run smoke:openai
npm run smoke:anthropic
```

## Example Usage

OpenAI-compatible chat request:

```bash
curl http://127.0.0.1:1234/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "local-model",
    "messages": [{"role": "user", "content": "Say hello."}],
    "max_tokens": 64
  }'
```

OpenAI client example:

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? 'local-relay',
  baseURL: 'http://127.0.0.1:1234/v1',
});

const out = await client.chat.completions.create({
  model: 'local-model',
  messages: [{ role: 'user', content: 'Hello from Relay' }],
});

console.log(out.choices[0]?.message?.content);
```

Cline-style setup:

- Provider: OpenAI-compatible
- Base URL: `http://127.0.0.1:1234/v1`
- API key: any non-empty value unless Relay auth is enabled
- Model: your local model id from [`GET /v1/models`](https://platform.openai.com/docs/api-reference/models/list)

## Read The Docs

- Hosted docs: `https://achuthanmukundan00.github.io/relay/`
- Local docs source: [[docs/](/home/achu/relay/docs)](https://github.com/achuthanmukundan00/relay/tree/main/docs)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Relay bind address |
| `PORT` | `1234` | Relay bind port |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:8080/v1` | Upstream API root |
| `DEFAULT_MODEL` | _(empty)_ | Fallback model id when client omits `model` |
| `REQUEST_TIMEOUT_SECONDS` | `600` | Upstream timeout per request |
| `MAX_REQUEST_BODY_BYTES` | `1048576` | Request body limit |
| `RELAY_PROBE_ON_STARTUP` | `true` | Probe upstream during startup |
| `RELAY_STRICT_STARTUP` | `false` | Fail startup if probe fails |
| `RELAY_OBSERVABILITY_ENABLED` | `true` | Enable `/relay/*` stats endpoints |
| `RELAY_LOG_PROMPTS` | `false` | Include prompt content in logs |
| `LOG_LEVEL` | `info` | Log verbosity |
| `API_KEY` | _(empty)_ | Optional bearer/x-api-key required by Relay |

## Scripts

- `npm run dev` - run Relay in watch mode for local development
- `npm run build` - typecheck build gate
- `npm test` - test suite
- `npm run smoke:openai` - OpenAI compatibility smoke check
- `npm run smoke:anthropic` - Anthropic compatibility smoke check
- `npm run check:local` - local verification (`test` + `build`)

## Troubleshooting

- `curl /health` fails: verify Relay is running on `HOST:PORT`.
- Upstream errors/timeouts: verify `UPSTREAM_BASE_URL` and upstream server health.
- `model not found`: call [`GET /v1/models`](https://platform.openai.com/docs/api-reference/models/list) and use a returned model id.
- Anthropic endpoint issues: ensure [`POST /v1/messages`](https://platform.claude.com/docs/en/api/messages) is enabled by relay capabilities and your client sends `anthropic-version`.

## Status

Relay is `v0.1.x`: early, stable enough for local-agent workflows, and still evolving.

## License

Apache-2.0
