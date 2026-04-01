---
name: Watchdog architecture for Claude agents
description: Event-driven watchdog services replace cron loops for delivering messages to agents via tmux
type: project
---

Агенты получают сообщения через systemd watchdog-сервисы, а не через polling /loop.

**Нарушо (Agent #1):** `claude-watchdog-naruto.service`
- Источник 1: `~/.claude/channels/telegram/message-queue.jsonl` (polling 1s, tracks last message_id via `/tmp/watchdog-naruto-last-tg-id`)
- Источник 2: Коноха SSE `/messages/naruto/stream` (curl subprocess, reconnect с backoff)
- Доставка: tmux send-keys в сессию `naruto`, только когда агент idle (❯ prompt)
- Debounce: 2s — батчит несколько событий в один промпт
- Log: `/tmp/watchdog-naruto.log`
- Script: `/home/ubuntu/scripts/watchdog-naruto.py`

**Мирай (Agent #3):** `claude-watchdog-mirai.service`
- Источник: Коноха SSE `/messages/mirai/stream`
- Доставка: tmux send-keys в сессию `mirai`
- Log: `/tmp/watchdog-mirai.log`
- Script: `/home/ubuntu/scripts/watchdog-mirai.py`

**Саске (Agent #2):** `claude-watchdog-sasuke.service` — запущен (реализован 2026-03-26)
- Источник 1: `telegram:incoming` Redis stream (consumer group `sasuke`, consumer `sasuke-worker`)
- Источник 2: Коноха SSE `/messages/sasuke/stream`
- Доставка: tmux send-keys в сессию `sasuke`, только когда агент idle
- Log: `/tmp/watchdog-sasuke.log`
- **/loop check_bus_and_konoha больше не нужен** — watchdog обрабатывает оба канала

**Why:** /loop тратит токены на обработку тишины каждую минуту. Watchdog fires только при реальных событиях. Более оперативно и экономно.

**How to apply:** При старте сессии Наруто — НЕ запускать /loop check_messages / check_konoha. Watchdog уже слушает. Если нужен ручной fallback — /loop доступен как резерв.

**Коноха краш-фикс (2026-03-26):** ioredis disconnect() в createSubscriber бросал unhandled exception → Bun падал. Фикс: try-catch вокруг disconnect + process.on('uncaughtException') в server.ts. Commit e235822.
