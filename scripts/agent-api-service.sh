#!/bin/bash
set -euo pipefail

set -a
source /home/ubuntu/.agent-env
set +a

AGENT_ID="${1:-}"
if [ -z "$AGENT_ID" ]; then
  echo "usage: $0 <agent_id>" >&2
  exit 1
fi

KONOHA_URL="${KONOHA_URL:-http://127.0.0.1:3200}"
STATUS_URL="$KONOHA_URL/agents/$AGENT_ID/status"
START_URL="$KONOHA_URL/agents/$AGENT_ID/start"
STOP_URL="$KONOHA_URL/agents/$AGENT_ID/stop"
AGENT_URL="$KONOHA_URL/agents/$AGENT_ID"
SWITCH_URL="$KONOHA_URL/agents/$AGENT_ID/switch-runtime"
NO_PROXY_VALUE="${no_proxy:-127.0.0.1,localhost}"
POLL_SEC="${AGENT_SERVICE_POLL_SEC:-10}"
FAILOVER_THRESHOLD="${AGENT_SERVICE_FAILOVER_THRESHOLD:-3}"
TMUX_SOCKET="$AGENT_ID"
TMUX_SESSION="$AGENT_ID"
DISABLED_LOGGED=0

request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" \
      -H "Authorization: Bearer $KONOHA_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$body" \
      "$url"
  else
    curl -fsS -X "$method" \
      -H "Authorization: Bearer $KONOHA_TOKEN" \
      "$url"
  fi
}

agent_status() {
  request GET "$STATUS_URL" | python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)
    print(data.get("status","unknown"))
except Exception:
    print("error")'
}

agent_json() {
  request GET "$AGENT_URL"
}

agent_field() {
  local field="$1"
  agent_json | python3 -c 'import json,sys
field=sys.argv[1]
try:
    data=json.load(sys.stdin)
    value=data
    for part in field.split("."):
        if isinstance(value, dict):
            value=value.get(part)
        else:
            value=None
            break
    if value is None:
        print("")
    elif isinstance(value, bool):
        print("true" if value else "false")
    else:
        print(value)
except Exception:
    print("")' "$field"
}

switch_runtime_profile() {
  local profile="$1"
  printf '{"llm_client_profile":"%s","restart":true}' "$profile" | \
    curl -fsS -X POST \
      -H "Authorization: Bearer $KONOHA_TOKEN" \
      -H "Content-Type: application/json" \
      --data @- \
      "$SWITCH_URL"
}

tmux_alive() {
  tmux -L "$TMUX_SOCKET" has-session -t "$TMUX_SESSION" >/dev/null 2>&1
}

lifecycle_disabled_by_profile() {
  python3 - "$AGENT_ID" <<'PY'
import os
import sys
from pathlib import Path

agent_id = sys.argv[1]
override = {item.strip() for item in os.environ.get("KONOHA_ENABLE_DISABLED_LIFECYCLE_AGENTS", "").split(",") if item.strip()}
if "all" in override or agent_id in override:
    print("enabled")
    raise SystemExit(0)

sys.path.insert(0, str(Path("/home/ubuntu/konoha/scripts")))
try:
    from service_profiles import resolve_service_profile_from_env
    profile = resolve_service_profile_from_env(os.environ)
except Exception:
    print("enabled")
    raise SystemExit(0)

print("disabled" if agent_id in profile.disabled_lifecycle_agents else "enabled")
PY
}

export no_proxy="$NO_PROXY_VALUE"

cleanup() {
  echo "[$(date)] agent-api-service: stopping $AGENT_ID via Konoha API"
  request POST "$STOP_URL" '{}' >/dev/null || true
  exit 0
}

trap cleanup TERM INT

echo "[$(date)] agent-api-service: managing $AGENT_ID via Konoha API"
FAILURES=0

while true; do
  # The local tmux session is the strongest signal that the interactive agent is alive.
  # Konoha status can lag or temporarily report stopped/starting during recovery.
  if tmux_alive; then
    FAILURES=0
    DISABLED_LOGGED=0
    sleep "$POLL_SEC"
    continue
  fi

  if [ "$(lifecycle_disabled_by_profile || echo enabled)" = "disabled" ]; then
    if [ "$DISABLED_LOGGED" -eq 0 ]; then
      echo "[$(date)] agent-api-service: $AGENT_ID disabled by selected lifecycle profile, not requesting /start"
      DISABLED_LOGGED=1
    fi
    FAILURES=0
    sleep "$POLL_SEC"
    continue
  fi
  DISABLED_LOGGED=0

  status="$(agent_status || true)"
  if [ "$status" = "starting" ]; then
    FAILURES=$((FAILURES + 1))
    echo "[$(date)] agent-api-service: $AGENT_ID status=starting but tmux missing, waiting before /start (attempt $FAILURES)"
    sleep 5
    if [ "$FAILURES" -lt "$FAILOVER_THRESHOLD" ]; then
      sleep "$POLL_SEC"
      continue
    fi
  fi

  if [ "$status" != "running" ]; then
    FAILURES=$((FAILURES + 1))
    echo "[$(date)] agent-api-service: $AGENT_ID status=$status, tmux missing, requesting /start"
    request POST "$START_URL" '{}' >/dev/null || true

    auto_fallback="$(agent_field auto_runtime_fallback || true)"
    active_profile="$(agent_field active_runtime_profile || true)"
    fallback_profile="$(agent_field fallback_runtime_profile || true)"
    if [ "$auto_fallback" = "true" ] && \
       [ -n "$fallback_profile" ] && \
       [ "$active_profile" != "$fallback_profile" ] && \
       [ "$FAILURES" -ge "$FAILOVER_THRESHOLD" ]; then
      echo "[$(date)] agent-api-service: $AGENT_ID still not running after $FAILURES attempts, switching runtime profile $active_profile -> $fallback_profile"
      switch_runtime_profile "$fallback_profile" >/dev/null || true
      FAILURES=0
    fi
    sleep 5
  else
    FAILURES=0
  fi
  sleep "$POLL_SEC"
done
