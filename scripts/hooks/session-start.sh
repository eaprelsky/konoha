#!/bin/bash
# Session Start Hook — register on Konoha bus and set status online
source /home/ubuntu/.agent-env 2>/dev/null

AGENT_ID="${KONOHA_AGENT_ID:-naruto}"
KONOHA_URL="${KONOHA_URL:-http://127.0.0.1:3200}"

# Send heartbeat to mark online
curl -s -X POST \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  "$KONOHA_URL/agents/$AGENT_ID/heartbeat" > /dev/null 2>&1

# Deduplication: skip SESSION_ONLINE if already sent within the last 30 seconds.
# Prevents 3x duplicate events during Claude context compaction / rapid restart cycles.
DEDUP_FILE="/tmp/session-start-dedup-${AGENT_ID}"
DEDUP_WINDOW=30
NOW=$(date +%s)
SKIP_ONLINE=0
if [ -f "$DEDUP_FILE" ]; then
    LAST=$(cat "$DEDUP_FILE" 2>/dev/null || echo 0)
    DIFF=$((NOW - LAST))
    if [ "$DIFF" -lt "$DEDUP_WINDOW" ]; then
        echo "[session-start] $AGENT_ID: SESSION_ONLINE dedup skip (sent ${DIFF}s ago, window=${DEDUP_WINDOW}s)" >&2
        SKIP_ONLINE=1
    fi
fi

if [ "$SKIP_ONLINE" -eq 0 ]; then
    echo "$NOW" > "$DEDUP_FILE"
    # Post SESSION_ONLINE event so other agents can confirm restart succeeded
    curl -s -X POST \
      -H "Authorization: Bearer $KONOHA_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"from\":\"$AGENT_ID\",\"to\":\"all\",\"type\":\"status\",\"text\":\"SESSION_ONLINE:$AGENT_ID\"}" \
      "$KONOHA_URL/messages" > /dev/null 2>&1
    echo "[session-start] $AGENT_ID online" >&2
fi

# Check for restart_context in pending Konoha messages, save for Claude to read
RESTART_CTX=$(curl -s -H "Authorization: Bearer $KONOHA_TOKEN" \
  "$KONOHA_URL/messages/$AGENT_ID" 2>/dev/null | \
  python3 -c "
import sys, json
try:
    msgs = json.load(sys.stdin)
    for m in reversed(msgs):
        if '[restart_context]' in m.get('text',''):
            print(m['text'])
            break
except: pass
" 2>/dev/null)

if [[ -n "$RESTART_CTX" ]]; then
  echo "[session-start] restart context found: $RESTART_CTX" >&2
  echo "$RESTART_CTX" > /tmp/claude-restart-context.txt
fi

# Pass through stdin
cat
