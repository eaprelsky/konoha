#!/bin/bash
# Session End Hook — save state and notify Konoha
source /home/ubuntu/.agent-env 2>/dev/null

AGENT_ID="${KONOHA_AGENT_ID:-naruto}"
KONOHA_URL="${KONOHA_URL:-http://127.0.0.1:3200}"

# Deduplication: skip if we already sent "going offline" within the last 30 seconds.
# Prevents 3x duplicate events during Claude context compaction / rapid restart cycles.
DEDUP_FILE="/tmp/session-end-dedup-${AGENT_ID}"
DEDUP_WINDOW=30
NOW=$(date +%s)
if [ -f "$DEDUP_FILE" ]; then
    LAST=$(cat "$DEDUP_FILE" 2>/dev/null || echo 0)
    DIFF=$((NOW - LAST))
    if [ "$DIFF" -lt "$DEDUP_WINDOW" ]; then
        echo "[session-end] $AGENT_ID: dedup skip (sent ${DIFF}s ago, window=${DEDUP_WINDOW}s)" >&2
        cat
        exit 0
    fi
fi
echo "$NOW" > "$DEDUP_FILE"

# Notify other agents that this agent is going offline
curl -s -X POST \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"$AGENT_ID\",\"to\":\"all\",\"type\":\"status\",\"text\":\"$AGENT_ID going offline (session end)\"}" \
  "$KONOHA_URL/messages" > /dev/null 2>&1

echo "[session-end] $AGENT_ID notified offline" >&2

# Pass through stdin
cat
