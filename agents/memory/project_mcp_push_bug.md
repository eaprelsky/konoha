---
name: MCP push notification bug — WORKAROUND
description: Push не работает стабильно. Workaround: standalone Grammy bot + polling check_messages каждую минуту.
type: project
---

## Статус: решено через watchdog (2026-03-27)

Push notifications через MCP claude/channel нестабильны — не используются.
Вместо /loop polling — watchdog-сервисы (systemd) доставляют сообщения агентам через tmux.

**Рабочая схема:**
1. Grammy бот получает сообщения от Telegram, пишет в message-queue.jsonl
2. claude-watchdog-naruto.service следит за файлом (1s poll) + Konoha SSE
3. При новом сообщении — watchdog делает tmux send-keys в сессию naruto
4. Наруто отвечает через python3 /home/ubuntu/tg-send.py

**НЕ делать:**
- Не запускать /loop check_messages / check_konoha — watchdog делает это эффективнее
- Не просить рестарт ради push — это создаёт цикл падений
