# Truncation Debugging

## Likely causes

- Relay request-size guard: `MAX_REQUEST_BODY_BYTES` (default `1048576`) in [`src/config.ts`](/home/achu/relay/src/config.ts) and enforced in [`src/server.ts`](/home/achu/relay/src/server.ts).
- Client-side truncation before Relay (Cline/request builder).
- Relay normalization edge cases in message/tool_result mapping:
  - OpenAI path: [`src/internal/openai-chat.ts`](/home/achu/relay/src/internal/openai-chat.ts)
  - Anthropic path: [`src/internal/anthropic-messages.ts`](/home/achu/relay/src/internal/anthropic-messages.ts)
- Upstream/model behavior:
  - `max_tokens` output cap (not input truncation).
  - context-window overflow at llama.cpp/model side.
  - long-context attention degradation (model behavior, not transport truncation).
- Streaming transport interruptions/malformed SSE (Relay now logs upstream/downstream SSE counts and byte totals).

## Enable diagnostics

```bash
RELAY_DEBUG_TRUNCATION=1 RELAY_DEBUG_TRUNCATION_CONTENT=1 npm start
```

`RELAY_DEBUG_TRUNCATION=1` logs:
- inbound request diagnostics (`truncation.inbound`)
- upstream payload diagnostics (`truncation.upstream_payload`)
- non-stream response sizes (`truncation.response`)
- stream event/byte counters (`truncation.stream`)

`RELAY_DEBUG_TRUNCATION_CONTENT=1` additionally logs first/last 80 chars for large fields.

## Run synthetic test and script

Tests:

```bash
node --experimental-strip-types --test tests/truncation-diagnostics.test.ts
```

Script:

```bash
./scripts/diagnose-truncation.sh http://127.0.0.1:1234 /v1/chat/completions
```

## Interpreting logs

- Relay-side truncation likely if:
  - `truncation.inbound` already shows missing END marker/fingerprint.
  - or inbound looks complete but `truncation.upstream_payload` loses END marker/fingerprint.
- Upstream/model truncation likely if:
  - inbound and upstream payload fingerprints are complete, but output stops early and stream/non-stream size logs are consistent with full input transit.
- llama.cpp context overflow likely if:
  - full payload reaches upstream, then generation ends with short/empty output, `length` stop reason, or unstable output quality at high context usage.
- Model attention failure likely if:
  - full payload reaches upstream but semantically ignores tail sections despite no transport truncation.

## Existing limits and assumptions found

- Request body hard cap: `MAX_REQUEST_BODY_BYTES` (default 1 MiB).
- Pre-read `Content-Length` checked before body read; body read is also counted incrementally.
- No explicit input string slicing in request normalization paths.
- Observability request snapshots intentionally summarize/truncate previews (does not affect forwarding behavior).
