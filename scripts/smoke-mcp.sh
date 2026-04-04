#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${MCP_BASE_URL:-http://127.0.0.1:3000}"
INTERNAL_TOKEN="${INTERNAL_API_TOKEN:-}"

check() {
  local name="$1"
  local method="$2"
  local path="$3"
  local body="${4:-}"

  local args=("-sS" "-o" "/dev/null" "-w" "%{http_code}" "-X" "$method")

  if [[ -n "$body" ]]; then
    args+=("-H" "Content-Type: application/json" "--data" "$body")
  fi

  if [[ "$path" == "/api/internal/model-registry/refresh" && -n "$INTERNAL_TOKEN" ]]; then
    args+=("-H" "x-internal-token: $INTERNAL_TOKEN")
  fi

  local status
  status="$(curl "${args[@]}" "$BASE_URL$path")"

  if [[ "$status" =~ ^2|3|4 ]]; then
    echo "[ok] $name -> $status"
  else
    echo "[fail] $name -> $status"
    return 1
  fi
}

check "models" GET "/api/models"
check "actors" GET "/api/actors"
check "chats" GET "/api/chats"
check "messages" GET "/api/messages"
check "chat" POST "/api/chat" '{"messages":[],"actorId":"smoke","chatId":"smoke","userId":"smoke"}'
check "long-term-memory" POST "/api/long-term-memory" '{"actorId":"smoke","chatId":"smoke","messages":[]}'

if [[ -n "$INTERNAL_TOKEN" ]]; then
  check "internal-model-refresh" POST "/api/internal/model-registry/refresh" '{}'
else
  echo "[skip] internal-model-refresh (INTERNAL_API_TOKEN is not set)"
fi
