# Relay v0.1.1 Release Notes

## What Works

- OpenAI-compatible endpoints: `/v1/chat/completions`, `/v1/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models`
- Anthropic-compatible endpoints: `/v1/messages`, `/v1/messages/count_tokens`
- Streaming normalization and SSE repair
- Canonical request/response normalization for supported client variants
- Runtime visibility through health/capability/stats endpoints

## What's Tested

- `npm test` covers canonical mapping, compatibility behavior, streaming, degraded mode handling, tool normalization, error compatibility, and config behavior
- Smoke checks:
  - `./scripts/smoke-local-openai.sh`
  - `npm run smoke:anthropic`

## Intentionally Missing

- Agent orchestration APIs (assistants/threads/runs)
- Realtime APIs
- Image/audio/file APIs
- Hosted-vendor control-plane parity
