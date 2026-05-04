#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:1234}"
ROUTE="${2:-/v1/chat/completions}"

START="START_TRUNCATION_MARKER"
END="END_TRUNCATION_MARKER"
BODY="$(printf 'ABCDE12345%.0s' {1..20000})"
PAYLOAD="${START}\n${BODY}\n${END}"

JSON="$(cat <<EOF
{"model":"llama","messages":[{"role":"user","content":"${PAYLOAD}"}]}
EOF
)"

STATUS="$(curl -sS -o /tmp/relay-truncation-response.json -w '%{http_code}' \
  -H 'content-type: application/json' \
  -X POST "${BASE_URL}${ROUTE}" \
  --data "$JSON")"

BYTES="$(printf '%s' "$JSON" | wc -c | tr -d ' ')"

echo "HTTP status: ${STATUS}"
echo "Payload bytes: ${BYTES}"
if [[ "${STATUS}" =~ ^2 ]]; then
  echo "Relay response: success"
else
  echo "Relay response: failed"
fi
echo "Enable diagnostics: RELAY_DEBUG_TRUNCATION=1 RELAY_DEBUG_TRUNCATION_CONTENT=1 npm start"
