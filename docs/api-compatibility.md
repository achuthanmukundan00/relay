# API Compatibility

Relay targets practical compatibility for local model servers, not vendor-complete parity.

## Supported Endpoints

- `GET /health`
- [`GET /v1/models`](https://platform.openai.com/docs/api-reference/models/list)
- [`GET /v1/models/:model`](https://platform.openai.com/docs/api-reference/models/retrieve)
- [`POST /v1/chat/completions`](https://developers.openai.com/api/reference/chat-completions/overview)
- [`POST /v1/completions`](https://platform.openai.com/docs/api-reference/completions/create)
- [`POST /v1/responses`](https://platform.openai.com/docs/api-reference/responses/create)
- [`GET /v1/responses/:id`](https://platform.openai.com/docs/api-reference/responses/get)
- [`DELETE /v1/responses/:id`](https://platform.openai.com/docs/api-reference/responses/delete)
- [`POST /v1/messages`](https://platform.claude.com/docs/en/api/messages)
- [`POST /v1/messages/count_tokens`](https://platform.claude.com/docs/en/api/messages/count_tokens)
- [`POST /v1/embeddings`](https://platform.openai.com/docs/api-reference/embeddings/create)
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
