#!/usr/bin/env bash
set -euo pipefail

DEST_DIR="/opt/relay"
SERVICE_NAME="relay.service"
REF=""

usage() {
  cat <<USAGE
Usage: $(basename "$0") --ref <git-ref> [--dest /opt/relay] [--service relay.service]

Deploy the current repository to the systemd relay location with a required ref guard.

Options:
  --ref      Required git ref (example: v0.1). Must resolve to HEAD.
  --dest     Destination directory (default: /opt/relay).
  --service  systemd service name (default: relay.service).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      REF="${2:-}"
      shift 2
      ;;
    --dest)
      DEST_DIR="${2:-}"
      shift 2
      ;;
    --service)
      SERVICE_NAME="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REF" ]]; then
  echo "--ref is required (example: --ref v0.1)" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

HEAD_COMMIT="$(git rev-parse HEAD)"
REF_COMMIT="$(git rev-parse "$REF^{commit}" 2>/dev/null || true)"

if [[ -z "$REF_COMMIT" ]]; then
  echo "Ref '$REF' does not exist" >&2
  exit 1
fi

if [[ "$HEAD_COMMIT" != "$REF_COMMIT" ]]; then
  echo "Ref guard failed: HEAD ($HEAD_COMMIT) != $REF ($REF_COMMIT)" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is dirty (tracked changes). Commit or stash before deploy." >&2
  exit 1
fi

if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Working tree has untracked files. Clean up before deploy." >&2
  exit 1
fi

echo "Deploying $(git rev-parse --short HEAD) to $DEST_DIR"
sudo mkdir -p "$DEST_DIR"
sudo rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  "$REPO_ROOT/" "$DEST_DIR/"

if [[ -f "$DEST_DIR/package-lock.json" ]]; then
  echo "Installing production dependencies in $DEST_DIR"
  sudo npm ci --omit=dev --prefix "$DEST_DIR"
else
  echo "Installing production dependencies in $DEST_DIR"
  sudo npm install --omit=dev --prefix "$DEST_DIR"
fi

echo "Restarting $SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "Running doctor"
npm run doctor

echo "Deploy complete"
