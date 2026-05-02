# Relay

Relay is an agent-grade OpenAI/Anthropic-compatible gateway for local `llama.cpp` models.

It normalizes supported client requests into a canonical internal model, forwards to an upstream OpenAI-like chat completion API, then maps results back to client protocol shapes.

## Quick Start

```bash
llama-server --model /path/to/model.gguf --host 127.0.0.1 --port 8080
npm install
npm run verify
npm start
```

Health check:

```bash
curl http://127.0.0.1:1234/health
npm run doctor
```

## Public Routes

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

## Compatibility

Relay targets practical local-model compatibility, not full hosted OpenAI/Anthropic feature parity.

Not implemented: hosted assistants/tools variants, image/audio/files/realtime APIs, and orchestration features.

## Docs

- [Architecture](docs/architecture.md)
- [Local Deployment](docs/local-deployment.md)
- [.env example](/home/achu/relay/.env.example)

## License

Apache-2.0
