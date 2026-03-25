#!/bin/bash
# Session End Hook — save state and notify Konoha
source /home/ubuntu/.agent-env 2>/dev/null

AGENT_ID="${KONOHA_AGENT_ID:-naruto}"
KONOHA_URL="${KONOHA_URL:-http://127.0.0.1:3200}"

# Notify other agents that this agent is going offline
curl -s -X POST \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"$AGENT_ID\",\"to\":\"all\",\"type\":\"status\",\"text\":\"$AGENT_ID going offline (session end)\"}" \
  "$KONOHA_URL/messages" > /dev/null 2>&1

echo "[session-end] $AGENT_ID notified offline" >&2

# Pass through stdin
cat
