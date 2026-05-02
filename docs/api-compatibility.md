# API Compatibility

Relay targets practical compatibility for local model servers, not vendor-complete parity.

## Supported Endpoints

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

## Non-Goals

- Hosted assistants/threads/runs orchestration
- Realtime APIs
- Image/audio/file APIs
- Full vendor control-plane semantics

## Behavior Notes

- Unknown/hosted-only fields are governed by field policy settings.
- Streaming output is normalized to protocol-appropriate SSE.
- Capability endpoints expose unsupported/degraded areas at runtime.
