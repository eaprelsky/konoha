#!/bin/bash
# Self-inject: schedule a message to an agent via Konoha after a delay.
# Usage: self-inject.sh <delay_seconds> <agent_id> <message>
# Example: self-inject.sh 30 naruto "Resuming after /new — read work-state.md"

source /home/ubuntu/.agent-env

DELAY="${1:-0}"
TO="${2:-naruto}"
TEXT="$3"

if [ -z "$TEXT" ]; then
  echo "Usage: self-inject.sh <delay_seconds> <agent_id> <message>" >&2
  exit 1
fi

sleep "$DELAY"

curl -s -X POST http://127.0.0.1:3200/messages \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"from\": \"self-inject\", \"to\": \"$TO\", \"text\": $(echo "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}"
