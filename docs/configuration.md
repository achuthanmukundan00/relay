# Configuration

Relay reads environment variables from process env (and commonly from `.env`).

## Core Variables

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `1234` | Bind port |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:8080/v1` | Upstream API root |
| `UPSTREAM_CTX_SIZE` | _(empty)_ | Running upstream context size (for example llama.cpp `--ctx-size`) exposed for clients |
| `DEFAULT_MODEL` | _(empty)_ | Fallback model |
| `REQUEST_TIMEOUT_SECONDS` | `600` | Upstream timeout |
| `MAX_REQUEST_BODY_BYTES` | `1048576` | Body size limit |
| `API_KEY` | _(empty)_ | If set, require auth key |

## Startup And Logging

| Variable | Default | Notes |
|---|---|---|
| `RELAY_PROBE_ON_STARTUP` | `true` | Probe upstream during startup |
| `RELAY_STRICT_STARTUP` | `false` | Exit if probe fails |
| `RELAY_OBSERVABILITY_ENABLED` | `true` | Enable `/relay/*` endpoints |
| `RELAY_LOG_PROMPTS` | `false` | Log prompt bodies |
| `LOG_LEVEL` | `info` | Log level |

## Compatibility Tuning

Relay supports multiple model profiles and field handling policies for better behavior with local providers.

- `RELAY_MODEL_PROFILE` controls defaults for known model families.
- `RELAY_FIELD_POLICY` controls how unknown/hosted-only fields are handled.

Use strict modes when you want predictable failures; use permissive modes when maximizing client compatibility.
