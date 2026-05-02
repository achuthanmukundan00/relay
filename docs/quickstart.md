# Quickstart

This quickstart gets Relay working in a few minutes.

## 1. Start A Local Model Server

Example using `llama.cpp`:

```bash
llama-server --model /path/to/model.gguf --host 127.0.0.1 --port 8080
```

Your upstream must expose OpenAI-style endpoints at `http://127.0.0.1:8080/v1`.

## 2. Install Relay

```bash
git clone https://github.com/achuthanmukundan00/relay.git
cd relay
npm install
cp .env.example .env
```

## 3. Start Relay

```bash
npm run dev
```

Relay starts on `http://127.0.0.1:1234` by default.

## 4. Verify Health

```bash
curl http://127.0.0.1:1234/health
```

Expected response contains `{"ok":true}`.

## 5. Run A Test Request

```bash
curl http://127.0.0.1:1234/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "local-model",
    "messages": [{"role": "user", "content": "Reply with OK"}],
    "max_tokens": 32
  }'
```

## 6. Connect A Client (Cline)

Use OpenAI-compatible mode:

- Base URL: `http://127.0.0.1:1234/v1`
- API key: any non-empty string (or your configured `API_KEY`)
- Model: choose one from `GET /v1/models`

## Optional Smoke Checks

```bash
npm run smoke:openai
npm run smoke:anthropic
```
