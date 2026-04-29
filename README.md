# Relay

Relay is a lightweight local gateway that exposes OpenAI-compatible and Anthropic-compatible API surfaces in front of a llama.cpp server.

By default the gateway binds to `127.0.0.1:8080` and proxies to `http://127.0.0.1:1234`.

## Development

```sh
npm test
npm start
```

## Deployment

Copy `.env.example` and adjust it for your machine. Keep `HOST=127.0.0.1` for local-only use. Set `HOST=0.0.0.0` only when you intentionally want LAN or container exposure.

### Docker Compose

The compose file builds the gateway image, exposes `8080:8080`, and points `UPSTREAM_BASE_URL` at the host llama.cpp server by default.

```sh
cp .env.example .env
docker compose up --build
```

Smoke tests:

```sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/v1/models
curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"local","messages":[{"role":"user","content":"hello"}]}'
```

If `API_KEY` is set, add `-H "Authorization: Bearer $API_KEY"` or `-H "x-api-key: $API_KEY"` to API requests.

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
