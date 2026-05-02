# Troubleshooting

## Relay Does Not Start

- Check Node version: `node -v` (requires Node 22+).
- Validate config: `cp .env.example .env` and confirm `UPSTREAM_BASE_URL`.
- Run tests/checks: `npm run check:local`.

## Health Check Fails

```bash
curl -v http://127.0.0.1:1234/health
```

If connection fails, Relay is not listening on expected `HOST`/`PORT`.

## Upstream Connection Errors

- Confirm upstream is running: `curl http://127.0.0.1:8080/health`.
- Confirm API root: `UPSTREAM_BASE_URL` should end with `/v1`.
- Review Relay logs for timeout or auth messages.

## Model Errors

- List models: `curl http://127.0.0.1:1234/v1/models`.
- Use a returned model ID explicitly in client requests.

## Smoke Test Failures

Run:

```bash
npm run smoke:openai
npm run smoke:anthropic
```

These fail fast with HTTP/error details for easier diagnosis.
