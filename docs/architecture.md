# Architecture

Relay translates a focused subset of OpenAI/Anthropic requests into a canonical internal model and forwards to an upstream OpenAI-compatible endpoint.

## Request And Response Flow

```text
client protocol
  -> endpoint parser/auth/field policy
  -> canonical request
  -> upstream OpenAI-like chat request
  -> canonical response/stream event
  -> client protocol response
```

## Canonical Layers

- Request model: `src/internal/canonical.ts`
- Protocol converters: `src/internal/openai-chat.ts`, `src/internal/openai-responses.ts`, `src/internal/anthropic-messages.ts`
- Response model: `src/internal/response.ts`
- Shared sampling logic: `src/internal/sampling.ts`

## Streaming Guarantees

- OpenAI chat streams emit one terminal `[DONE]`.
- Missing `[DONE]` is repaired; duplicates are collapsed.
- Responses and Anthropic streams are emitted in protocol-appropriate event order.

## Observability

When enabled, Relay exposes:

- `/relay/capabilities`
- `/relay/stats`
- `/relay/requests`
- `/relay/requests/:id`

Sensitive values are redacted by default.
