# Relay

Relay is a small OpenAI/Anthropic-compatible gateway for a running `llama.cpp` `llama-server`.

It accepts a focused subset of OpenAI and Anthropic requests, normalizes them, and forwards them upstream. The goal is to make local model integrations easier to debug without turning this repo into a giant platform project.

## Scope

Implemented endpoints:

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/:model`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `GET /v1/responses/:id`
- `DELETE /v1/responses/:id`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/embeddings`
- `POST /v1/rerank`
- `POST /rerank`
- `GET /relay/capabilities`
- `POST /relay/capabilities/refresh`
- `GET /relay/stats`
- `GET /relay/requests`
- `GET /relay/requests/:id`

Out of scope:

- hosted OpenAI tools and assistants APIs
- image, audio, files, batches, and realtime APIs
- model serving
- UI or workflow orchestration

## Quick Start

1. Start `llama-server`:

```bash
llama-server --model /path/to/model.gguf --host 127.0.0.1 --port 8080
```

2. Install and run Relay:

```bash
npm install
npm run verify
npm start
```

3. Check the stack:

```bash
curl http://127.0.0.1:1234/health
npm run doctor
```

4. Send a request:

```bash
curl -X POST http://127.0.0.1:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "messages": [{"role": "user", "content": "Say OK"}],
    "max_tokens": 16
  }'
```

## Configuration

Common environment variables:

| Variable | Default |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `PORT` | `1234` |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:8080/v1` |
| `DEFAULT_MODEL` | empty |
| `REQUEST_TIMEOUT_SECONDS` | `600` |
| `MAX_REQUEST_BODY_BYTES` | `1048576` |
| `RELAY_PROBE_ON_STARTUP` | `true` |
| `RELAY_STRICT_STARTUP` | `false` |
| `RELAY_OBSERVABILITY_ENABLED` | `true` |
| `RELAY_LOG_PROMPTS` | `false` |
| `LOG_LEVEL` | `info` |
| `API_KEY` | empty |

See [.env.example](/home/achu/relay/.env.example) for a minimal local config.

## Docker

```bash
docker compose up --build
```

By default the container points at `http://host.docker.internal:8080/v1`.

## Notes

- OpenAI-compatible base URL: `http://127.0.0.1:1234/v1`
- Anthropic-compatible base URL: `http://127.0.0.1:1234`
- `npm run doctor` is the main live-stack check
- `npm run verify` runs tests and typecheck without a live upstream

## License

Apache-2.0
