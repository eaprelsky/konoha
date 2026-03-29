#!/bin/bash
# Safe restart protocol — broadcasts restart intent to Konoha, then restarts agent.
# The other agent (watchdog) monitors recovery and notifies Yegor.
# Usage: restart-safe.sh <agent_id> [reason]
#   agent_id: naruto | sasuke

source /home/ubuntu/.agent-env 2>/dev/null

AGENT="${1}"
REASON="${2:-manual restart}"
SELF="${KONOHA_AGENT_ID:-naruto}"
KONOHA_URL="${KONOHA_URL:-http://127.0.0.1:3200}"
KONOHA_HEADERS=(-H "Authorization: Bearer $KONOHA_TOKEN" -H "Content-Type: application/json")

if [[ -z "$AGENT" ]]; then
  echo "Usage: restart-safe.sh <agent_id> [reason]"
  echo "  agent_id: naruto | sasuke"
  exit 1
fi

if [[ ! -f "/home/ubuntu/scripts/restart-${AGENT}.sh" ]]; then
  echo "Error: unknown agent '$AGENT'"
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "[restart-safe] Initiating safe restart of $AGENT (reason: $REASON)"

# Broadcast restart intent to all agents so the watchdog picks it up
curl -s -X POST "${KONOHA_HEADERS[@]}" \
  -d "{\"from\":\"$SELF\",\"to\":\"all\",\"text\":\"[restart_pending] agent=$AGENT reason=$REASON ts=$TIMESTAMP\"}" \
  "$KONOHA_URL/messages" > /dev/null

# Also send directly to the agent's queue as restart context (survives restart)
curl -s -X POST "${KONOHA_HEADERS[@]}" \
  -d "{\"from\":\"$SELF\",\"to\":\"$AGENT\",\"text\":\"[restart_context] reason=$REASON initiated_by=$SELF ts=$TIMESTAMP\"}" \
  "$KONOHA_URL/messages" > /dev/null

echo "[restart-safe] Restart intent broadcast. Triggering restart in 3s..."

# Trigger restart (small delay for messages to propagate)
bash "/home/ubuntu/scripts/restart-${AGENT}.sh" 3
