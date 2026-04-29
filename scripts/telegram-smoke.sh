#!/usr/bin/env bash
set -euo pipefail

CHAT_ID="${1:-93791246}"

check_group() {
  local stream="$1"
  local group="$2"
  local max_lag="${3:-100}"
  local pending lag

  pending=$(redis-cli --raw XINFO GROUPS "$stream" \
    | awk -v g="$group" '
      $0 == "name" { getline name }
      $0 == "pending" { getline p }
      $0 == "lag" { getline l; if (name == g) { print p ":" l; found=1 } }
      END { if (!found) exit 1 }
    ')
  if [ -z "$pending" ]; then
    echo "FAIL: missing group $stream/$group" >&2
    exit 1
  fi

  lag="${pending#*:}"
  pending="${pending%%:*}"
  echo "$stream/$group pending=$pending lag=$lag"
  if [ "$pending" != "0" ]; then
    echo "FAIL: $stream/$group pending=$pending" >&2
    exit 1
  fi
  if [ "$lag" != "" ] && [ "$lag" != "0" ] && [ "$lag" -gt "$max_lag" ]; then
    echo "FAIL: $stream/$group lag=$lag > $max_lag" >&2
    exit 1
  fi
}

check_dead_letter() {
  local stream="$1"
  local len
  len=$(redis-cli XLEN "$stream")
  echo "$stream len=$len"
  if [ "$len" != "0" ]; then
    echo "FAIL: $stream is not empty" >&2
    exit 1
  fi
}

check_stream_health() {
  check_group telegram:bot:incoming naruto
  check_group telegram:incoming sasuke
  check_group telegram:outgoing claude-agents
  check_group telegram:needs_context context-packer
  check_group telegram:vision_requests vision-packer
  check_dead_letter telegram:needs_context:dead_letter
  check_dead_letter telegram:vision_requests:dead_letter
  check_dead_letter telegram:outgoing:dead_letter
}

echo "== pre-smoke stream health =="
check_stream_health

TOKEN="SMOKE-SASUKE-$(date +%s)"
ID=$(redis-cli XADD telegram:incoming "*" \
  chat_id "$CHAT_ID" \
  chat_title "Smoke Test" \
  is_group 0 \
  msg_id "$(date +%s)" \
  sender_id "$CHAT_ID" \
  sender_name "Smoke Test" \
  sender_username smoke \
  text "$TOKEN: ответь коротко через tg-send-user.py что контур работает" \
  reply_to "" \
  timestamp "$(date -Iseconds)" \
  action_hint respond)

echo "injected=$ID token=$TOKEN"
sleep "${SMOKE_WAIT_SEC:-35}"
PENDING=$(redis-cli XPENDING telegram:incoming sasuke | sed -n "1p")
echo "sasuke_pending=$PENDING"
journalctl --no-pager --since "2 minutes ago" -u agent-watchdog-sasuke -u telegram-bus | grep -E "$TOKEN|OUT|Acked" | tail -40 || true
if [ "$PENDING" != "0" ]; then
  echo "FAIL: sasuke pending is not zero" >&2
  exit 1
fi

echo "== post-smoke stream health =="
check_stream_health
