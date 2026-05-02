# Relay

<p align="center">
  <img src="relay_logo_github.png" alt="Relay" width="120" />
</p>

<p align="center">
  A lightweight OpenAI/Anthropic-compatible gateway for local llama.cpp models.
</p>

Relay is a small local compatibility layer. It sits in front of a running `llama-server`, accepts a focused subset of OpenAI and Anthropic client traffic, normalizes the request shape, and sends the work upstream.

## What Relay Is

- a local HTTP gateway
- an OpenAI Chat/Completions/Responses compatibility layer
- an Anthropic Messages compatibility layer
- a thin adapter for a running `llama.cpp` server
- a repo that prefers explicit behavior, small modules, and behavior tests over provider cosplay

## What Relay Is Not

- not a model runner
- not a hosted inference service
- not a UI
- not a replacement for `llama.cpp`
- not a guarantee of full hosted OpenAI or Anthropic feature parity
- not an embeddings, rerank, realtime, assistants, or vector-store implementation

## Architecture

```text
agent / SDK client
        |
        v
Relay on 127.0.0.1:1234
        |
        v
llama.cpp llama-server on 127.0.0.1:8080/v1
        |
        v
local GGUF model
```

## Current Scope

Implemented Relay surfaces:

- `GET /health`
- `GET /v1/models`
- `GET /v1/models/:model`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- stored chat completion helpers under `/v1/chat/completions/:id*`
- `POST /v1/responses`
- `GET /v1/responses/:id`
- `DELETE /v1/responses/:id`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /relay/capabilities`
- `POST /relay/capabilities/refresh`

Unsupported or intentionally out of scope:

- `/v1/embeddings`
- rerank APIs
- hosted tools such as web search, file search, code interpreter, and computer use
- `/v1/images/*`
- `/v1/audio/*`
- `/v1/files`
- `/v1/batches`
- `/v1/fine_tuning/*`
- `/v1/vector_stores/*`
- `/v1/assistants/*`
- `/v1/threads/*`
- `/v1/realtime/*`

## Base URLs

- OpenAI-compatible base URL: `http://127.0.0.1:1234/v1`
- Anthropic-compatible base URL: `http://127.0.0.1:1234`
- llama.cpp upstream base URL: `http://127.0.0.1:8080/v1`

Anthropic SDKs should use the Relay base URL, not `.../v1/messages`. The SDK appends the messages path itself.

## Quick Start

1. Start `llama-server`:

```bash
llama-server --model /path/to/model.gguf --host 127.0.0.1 --port 8080 --ctx-size 16384 --cache-ram 0 --batch-size 1024 --ubatch-size 512 -ngl 999
```

If your current llama.cpp build supports it for the selected model template, add `--reasoning off` during agent smoke testing.

2. Install and start Relay:

```bash
npm install
npm test
npm start
```

3. Check the local stack:

```bash
curl http://127.0.0.1:1234/health
curl http://127.0.0.1:1234/v1/models
./scripts/smoke-local-openai.sh
```

4. Send a chat completion:

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

Relay reads these environment variables:

| Variable | Default |
|---|---|
| `HOST` | `127.0.0.1` |
| `PORT` | `1234` |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:8080/v1` |
| `DEFAULT_MODEL` | empty |
| `DEFAULT_TEMPERATURE` | `1.0` |
| `DEFAULT_TOP_P` | `0.95` |
| `DEFAULT_TOP_K` | `20` |
| `DEFAULT_MIN_P` | `0.0` |
| `DEFAULT_PRESENCE_PENALTY` | `1.5` |
| `DEFAULT_REPETITION_PENALTY` | `1.0` |
| `REQUEST_TIMEOUT_SECONDS` | `600` |
| `MAX_REQUEST_BODY_BYTES` | `1048576` |
| `RELAY_PROBE_ON_STARTUP` | `true` |
| `RELAY_STRICT_STARTUP` | `false` |
| `RELAY_PROBE_TIMEOUT_MS` | `3000` |
| `RELAY_UNKNOWN_FIELD_POLICY` | `pass_through` |
| `RELAY_STRICT_COMPAT` | `false` |
| `RELAY_WARN_ON_STRIPPED_FIELDS` | `true` |
| `LOG_LEVEL` | `info` |
| `API_KEY` | empty |

See [.env.example](/home/achu/relay/.env.example) for the repo-default file.

## API Examples

OpenAI-compatible models:

```bash
curl http://127.0.0.1:1234/v1/models
```

OpenAI-compatible Responses:

```bash
curl -X POST http://127.0.0.1:1234/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "input": "Say OK",
    "store": false
  }'
```

Anthropic-compatible Messages:

```bash
curl -X POST http://127.0.0.1:1234/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "local",
    "max_tokens": 16,
    "messages": [{"role": "user", "content": "Say OK"}]
  }'
```

Anthropic-compatible `count_tokens`:

```bash
curl -X POST http://127.0.0.1:1234/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "local",
    "messages": [{"role": "user", "content": "Count these tokens."}]
  }'
```

## Client Setup

### OpenAI SDK

```js
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.API_KEY ?? 'local',
  baseURL: 'http://127.0.0.1:1234/v1',
});
```

### Anthropic SDK

```js
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? 'local',
  baseURL: 'http://127.0.0.1:1234',
});
```

### OpenAI-Compatible Clients

- Cline/OpenCode-style clients: use `http://127.0.0.1:1234/v1`
- Aider: set `OPENAI_API_BASE=http://127.0.0.1:1234/v1`
- Continue: use an OpenAI provider pointed at `http://127.0.0.1:1234/v1`

Example snippets still used in the repo tests:

```json
{
  "apiProvider": "openai-compatible",
  "openAiBaseUrl": "http://127.0.0.1:1234/v1",
  "openAiApiKey": "local-or-your-API_KEY",
  "model": "local"
}
```

```json
{
  "models": [
    {
      "title": "Local llama.cpp via Relay",
      "provider": "openai",
      "model": "local",
      "apiBase": "http://127.0.0.1:1234/v1",
      "apiKey": "local-or-your-API_KEY"
    }
  ]
}
```

```yaml
openai_api_base: http://127.0.0.1:1234/v1
model: openai/local
```

## Compatibility Caveats

- The test suite is mostly mocked handler coverage.
- Real SDK smoke scripts live under `scripts/compat/`.
- Manual client smoke steps live in [docs/manual-smoke-testing.md](/home/achu/relay/docs/manual-smoke-testing.md).
- The compatibility status table lives in [docs/compatibility-matrix.md](/home/achu/relay/docs/compatibility-matrix.md).
- Large agent prompts on big models can spend multiple minutes in llama.cpp prefill before first token. See [docs/agents.md](/home/achu/relay/docs/agents.md) and [docs/deploy-systemd.md](/home/achu/relay/docs/deploy-systemd.md) for the safer debug profile and the large-context warning.
- Continue-style embeddings workflows are still out of scope because embeddings are not implemented.
- Vision should be treated as unproven unless you explicitly configure and test it against your local upstream.

## Development

```bash
npm install
npm test
npm start
```

## Deployment

Relay listens on `127.0.0.1:1234`.

llama.cpp upstream listens on `127.0.0.1:8080`.

The repo includes Docker and systemd examples, but nothing modifies `/etc` or systemd unless you explicitly run those scripts yourself.

- Docker Compose: `docker compose up --build`
- systemd docs: [docs/deploy-systemd.md](/home/achu/relay/docs/deploy-systemd.md)
- local smoke helpers: `scripts/check-local-stack.sh`, `scripts/smoke-openai.sh`, `scripts/smoke-anthropic.sh`

## Security Notes

- If `API_KEY` is unset, Relay allows unauthenticated local use.
- If `API_KEY` is set, requests must include `Authorization: Bearer <key>` or `x-api-key: <key>`.
- Request bodies are capped by `MAX_REQUEST_BODY_BYTES`.
- Keep `HOST=127.0.0.1` for local-only use unless you intentionally want LAN exposure.

## License

Apache-2.0. See [LICENSE](/home/achu/relay/LICENSE).
