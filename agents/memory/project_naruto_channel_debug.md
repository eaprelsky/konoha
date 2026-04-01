---
name: Naruto channel — push notifications via MCP claude/channel
description: Push notifications работают через experimental claude/channel capability + notifications/claude/channel. Исправлено 2026-03-24.
type: project
---

Push-уведомления от MCP-сервера naruto-channel к Claude Code.

**Решение (2026-03-24):**
Стандартный Telegram-плагин Claude Code использует:
1. `capabilities: { experimental: { 'claude/channel': {} } }` — объявляет сервер как канал
2. `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })` — отправляет сообщения

Раньше naruto-channel использовал `resources: { subscribe: true }` + `sendResourceUpdated` — Claude Code это игнорировал, т.к. не считал сервер каналом.

**Формат meta:** `{ chat_id, message_id, user, user_id, ts, image_path?, attachment_kind?, attachment_file_id?, attachment_name? }`

**Код:** /home/ubuntu/naruto-channel/server.ts
**Лог:** /tmp/naruto-channel.log
**Очередь (fallback):** ~/.claude/channels/telegram/message-queue.jsonl
**Tool check_messages:** оставлен как fallback на случай проблем с push

**Why:** Без рабочего канала Наруто не может получать сообщения от Егора через Telegram в реальном времени.
**How to apply:** При любых изменениях в push-механизме проверять совместимость с форматом стандартного плагина: capabilities experimental claude/channel + notifications/claude/channel.
