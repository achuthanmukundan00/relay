# Relay Architecture

Relay is an agent-grade local-model gateway that translates a focused subset of OpenAI and Anthropic APIs into an upstream OpenAI-compatible chat completion call.

## Request/Response Flow

```text
client protocol
  -> endpoint parser/auth/field policy
  -> canonical request
  -> upstream OpenAI-like chat request
  -> canonical response/stream event
  -> client protocol response
```

## Supported Public Routes

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

## Canonical Internal Models

- Request model: `src/internal/canonical.ts` + protocol converters in `src/internal/openai-chat.ts`, `src/internal/openai-responses.ts`, and `src/internal/anthropic-messages.ts`.
- Response model: `src/internal/response.ts`.
- Shared sampling defaults: `src/internal/sampling.ts`.

## Streaming Invariants

- OpenAI chat stream emits exactly one `[DONE]`.
- Missing upstream `[DONE]` is repaired.
- Duplicate upstream `[DONE]` is collapsed.
- Responses stream emits `response.created`, delta events, then `response.completed` or `response.failed`.
- Anthropic stream emits message/content block events and `message_stop`.
- Malformed streaming chunks degrade to protocol-appropriate error events.

## Field Policies

Relay supports three unknown-field policies:

- `pass_through`
- `strip`
- `reject`

Hosted-only fields may be stripped in permissive mode and rejected in strict compatibility mode.

## Compatibility Limits

Relay intentionally provides approximate compatibility for local models and does not implement full hosted OpenAI/Anthropic parity.

Known non-goals include hosted assistants/tools variants, realtime/image/audio/files APIs, and orchestration features.

## Observability

- `GET /relay/stats` for aggregate runtime stats.
- `GET /relay/requests` for recent request summaries.
- `GET /relay/requests/:id` for per-request detail.

Sensitive values are redacted by default. Prompt bodies are only included when explicit prompt logging is enabled.

## Safe Refactor Boundaries

Safe zones:

- `src/internal/**` canonical request/response transforms
- conversion parity tests under `tests/**`
- docs

High-risk zones (require focused parity checks):

- `src/normalize/stream.ts`
- endpoint stream handlers
- field-policy and auth behavior
