#!/bin/bash
# Sends a session-cleanup signal to Naruto via Konoha.
# Naruto will save workstate and run /new to clear context.
source /home/ubuntu/.agent-env

curl -s -X POST http://127.0.0.1:3200/messages \
  -H "Authorization: Bearer $KONOHA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "system",
    "to": "naruto",
    "text": "naruto:session-cleanup — Сохрани workstate и запусти /new для очистки контекста."
  }'

echo "[$(date)] Session-cleanup signal sent to Naruto"
