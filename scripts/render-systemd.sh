#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-deploy/rendered}"
TEMPLATE="deploy/relay.service.example"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing template: $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp "$TEMPLATE" "$OUT_DIR/relay.service"

echo "Rendered: $OUT_DIR/relay.service"
echo "Next: sudo cp $OUT_DIR/*.service /etc/systemd/system/"
