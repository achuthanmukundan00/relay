# Systemd Deployment

This guide covers practical service deployment using the included helper scripts.

## 1. Render Unit Files

Generate unit files from templates:

```bash
scripts/render-systemd.sh
```

By default this writes rendered units to `deploy/rendered/`.

## 2. Copy Units To Systemd

```bash
sudo cp deploy/rendered/*.service /etc/systemd/system/
```

## 3. Install And Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable relay.service
sudo systemctl start relay.service
```

## 4. Verify Service Health

```bash
sudo systemctl status relay.service --no-pager
curl http://127.0.0.1:1234/health
```

## 5. View Logs

```bash
journalctl -u relay.service -n 100 --no-pager
journalctl -u relay.service -f
```

## 6. Restart When Needed

```bash
sudo systemctl restart relay.service
```

## Optional Guarded Deploy

Use the guarded deploy script to sync this repository to `/opt/relay` with a git ref check:

```bash
scripts/deploy-to-opt.sh --ref v0.1.0
```
