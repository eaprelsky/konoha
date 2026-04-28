#!/usr/bin/env bash
set -euo pipefail

CHAT_ID="${1:-93791246}"
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
