# Local Deployment

1. Run `llama-server`:

```bash
llama-server --model /path/to/model.gguf --host 127.0.0.1 --port 8080
```

2. Configure Relay (see `.env.example`).
3. Verify and start:

```bash
npm install
npm run verify
npm start
```

4. Smoke-check:

```bash
curl http://127.0.0.1:1234/health
npm run doctor
```

## Guarded Service Deploy

Use this when your systemd service runs from `/opt/relay` and you want explicit, frozen deploys:

```bash
scripts/deploy-to-opt.sh --ref v0.1
```

The script refuses dirty worktrees, verifies `HEAD` matches the required ref, syncs into `/opt/relay`, restarts `relay.service`, and runs `npm run doctor`.
