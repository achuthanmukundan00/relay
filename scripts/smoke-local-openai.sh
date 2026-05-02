#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL smoke-local-openai: node is required" >&2
  exit 1
fi

node --experimental-strip-types scripts/smoke-openai.ts
