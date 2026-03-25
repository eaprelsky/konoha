#!/bin/bash
# Check Telegram message queue for new messages (deduplicated).
# Tracks last processed message_id to avoid reprocessing after restart.
# Usage: check-messages.sh [agent_id]
# Outputs new messages as JSON lines to stdout.

AGENT="${1:-naruto}"
QUEUE_FILE="$HOME/.claude/channels/telegram/message-queue.jsonl"
LAST_ID_FILE="$HOME/.claude/channels/telegram/last-processed-${AGENT}.txt"

if [[ ! -f "$QUEUE_FILE" ]]; then
  echo "[]"
  exit 0
fi

# Read last processed message_id (0 if not set)
LAST_ID=0
if [[ -f "$LAST_ID_FILE" ]]; then
  LAST_ID=$(cat "$LAST_ID_FILE" | tr -d '[:space:]')
  [[ "$LAST_ID" =~ ^[0-9]+$ ]] || LAST_ID=0
fi

# Filter messages with message_id > last processed
python3 - "$QUEUE_FILE" "$LAST_ID" <<'EOF'
import sys, json

queue_file = sys.argv[1]
last_id = int(sys.argv[2])

new_messages = []
with open(queue_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            msg_id = int(msg.get('message_id', 0))
            # Only process messages from bot channel (source=bot or no source for legacy)
            source = msg.get('source', 'bot')
            if msg_id > last_id and source == 'bot':
                new_messages.append(msg)
        except:
            pass

for msg in new_messages:
    print(json.dumps(msg, ensure_ascii=False))
EOF

# Update last processed ID to the highest message_id seen in queue
python3 -c "
import json, sys
try:
    msgs = []
    with open('$QUEUE_FILE') as f:
        for line in f:
            line = line.strip()
            if line:
                msgs.append(json.loads(line))
    if msgs:
        max_id = max(int(m.get('message_id', 0)) for m in msgs)
        print(max_id)
except:
    print($LAST_ID)
" > "$LAST_ID_FILE" 2>/dev/null
