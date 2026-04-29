# Relay

Relay is a lightweight local agent gateway for llama.cpp. It exposes OpenAI-compatible and Anthropic-compatible HTTP APIs in front of a running `llama-server`.

## What This Is

Relay is a compatibility gateway, not an inference engine. It does not load models, run sampling, or replace llama.cpp. It accepts the endpoint shapes used by agent tools, normalizes them to the best-supported llama.cpp `/v1/chat/completions` request, and translates responses back into the provider shape the client expects.

By default Relay listens on `127.0.0.1:1234` and proxies to the llama.cpp upstream on `http://127.0.0.1:8080`.

## Why It Exists

Local agents often speak slightly different OpenAI or Anthropic dialects. llama.cpp is close to OpenAI-compatible, but tools can still trip over fields like `developer` messages, `max_completion_tokens`, Anthropic `tool_use` blocks, Responses API probes, or provider-specific stream formats. Relay smooths over those differences so tools such as Cline, Continue, Aider, OpenCode-style clients, Pi-style clients, and Claude-Code-style Anthropic clients can point at one local gateway.

## Quick Start

With Node 25 and a llama.cpp server already running, a fresh user can run the gateway in under five minutes:

```sh
git clone <this-repo-url> relay
cd relay
cp .env.example .env
npm test
npm start
```

In another terminal, run the smoke tests below. If you set `API_KEY`, add `-H "Authorization: Bearer $API_KEY"` or `-H "x-api-key: $API_KEY"` to API requests.

## Supported Endpoints

- GET `/health`
- GET `/v1/models`
- GET `/v1/models/:model`
- POST `/v1/chat/completions`
- POST `/v1/completions`
- GET `/v1/chat/completions`
- GET `/v1/chat/completions/:completion_id`
- POST `/v1/chat/completions/:completion_id`
- DELETE `/v1/chat/completions/:completion_id`
- GET `/v1/chat/completions/:completion_id/messages`
- POST `/v1/responses`
- GET `/v1/responses/:id`
- DELETE `/v1/responses/:id`
- POST `/v1/messages`

## Unsupported Endpoints

- OpenAI Embeddings passthrough is not implemented yet.
- Audio, image, and file modalities are rejected unless the local upstream explicitly supports the requested path.
- Batch, fine-tuning, assistants, vector stores, realtime, and hosted tool endpoints are not implemented.
- Relay does not provide model inference, model downloads, model routing, or database persistence.

## llama.cpp Setup Example

Final local port topology:

- Relay listens on `127.0.0.1:1234`.
- llama.cpp upstream listens on `127.0.0.1:8080`.
- OpenAI-compatible agents use `http://127.0.0.1:1234/v1`.
- Anthropic-compatible clients use `http://127.0.0.1:1234/v1/messages`.

Start `llama-server` on the upstream port:

```sh
llama-server \
  --model /path/to/model.gguf \
  --host 127.0.0.1 \
  --port 8080
```

One-line equivalent:

```sh
llama-server --model /path/to/model.gguf --host 127.0.0.1 --port 8080
```

Then start Relay:

```sh
PORT=1234 UPSTREAM_BASE_URL=http://127.0.0.1:8080 npm start
```

## Smoke Tests

```sh
curl http://127.0.0.1:1234/health

curl http://127.0.0.1:1234/v1/models

curl -X POST http://127.0.0.1:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "messages": [{"role": "user", "content": "Say OK"}],
    "max_tokens": 16
  }'
```

## Client Examples

### Cline

Use OpenAI-compatible mode and point the base URL at Relay:

```json
{
  "apiProvider": "openai-compatible",
  "openAiBaseUrl": "http://127.0.0.1:1234/v1",
  "openAiApiKey": "local-or-your-API_KEY",
  "model": "local"
}
```

### Continue

Add an OpenAI-compatible model entry:

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

### Aider

Point Aider at the OpenAI-compatible base URL:

```sh
export OPENAI_API_KEY=local-or-your-API_KEY
export OPENAI_API_BASE=http://127.0.0.1:1234/v1
aider --model openai/local
```

An `.aider.conf.yml` equivalent:

```yaml
openai_api_base: http://127.0.0.1:1234/v1
model: openai/local
```

### OpenAI SDK

```js
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.API_KEY ?? 'local',
  baseURL: 'http://127.0.0.1:1234/v1',
});

const completion = await client.chat.completions.create({
  model: 'local',
  messages: [{ role: 'user', content: 'Say OK' }],
});

console.log(completion.choices[0].message.content);
```

### Claude-Code-Style Anthropic Clients

Use Relay as the Anthropic base URL and any local key unless `API_KEY` is configured:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:1234
export ANTHROPIC_API_KEY=local-or-your-API_KEY
```

Relay accepts `x-api-key` and `Authorization: Bearer ...`; it does not require a real Anthropic key.

## Security Notes

- If `API_KEY` is unset, Relay allows unauthenticated local use.
- If `API_KEY` is set, requests must include `Authorization: Bearer <key>` or `x-api-key: <key>`.
- HTTP request bodies are capped by `MAX_REQUEST_BODY_BYTES` and default to 1 MiB.
- Logs include request IDs and sanitized errors, not full prompts or API keys.
- Keep `HOST=127.0.0.1` for local-only use. Set `HOST=0.0.0.0` only when you intentionally want LAN or container exposure.
- Relay is intended for trusted local networks. Put a real reverse proxy and TLS in front of it before exposing it beyond your machine.

## Troubleshooting

- `GET /health` works but completions fail: confirm `llama-server` is running and `UPSTREAM_BASE_URL` points to it.
- `GET /v1/models` returns a gateway error: start llama.cpp with its OpenAI-compatible server enabled, or set `DEFAULT_MODEL` for synthetic discovery.
- The client gets `401`: check `API_KEY`, `Authorization`, and `x-api-key` values.
- Tool calls fail: inspect whether the upstream returned valid JSON function arguments.
- Anthropic clients stream oddly: confirm the client is pointed at `http://127.0.0.1:1234`, not `/v1`, for `/v1/messages`.
- LAN clients cannot connect: set `HOST=0.0.0.0`, restart Relay, and verify firewall rules.

## Development

```sh
npm test
npm start
```

## Deployment

Copy `.env.example` and adjust it for your machine. Keep `HOST=127.0.0.1` for local-only use. Set `HOST=0.0.0.0` only when you intentionally want LAN or container exposure.

### Docker Compose

The compose file builds the gateway image, exposes `1234:1234`, and points `UPSTREAM_BASE_URL` at the host llama.cpp server on port 8080 by default.

```sh
cp .env.example .env
docker compose up --build
```

### systemd

Create a dedicated user and install the app under `/opt/relay`:

```sh
sudo useradd --system --home /opt/relay --shell /usr/sbin/nologin relay
sudo mkdir -p /opt/relay /etc/relay
sudo cp -R . /opt/relay
sudo cp .env.example /etc/relay/relay.env
sudo chown -R relay:relay /opt/relay
sudo cp deploy/relay.service /etc/systemd/system/relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now relay
```

Check status and logs:

```sh
systemctl status relay
journalctl -u relay -f
```
