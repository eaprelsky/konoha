---
name: Infrastructure changelog
description: История изменений konoha, telegram-bot-service, hooks, claude-naruto-service.sh. Читать перед правками.
type: project
---

## Текущее состояние (2026-03-25, сессия 11)

### Транспорт агентов — ЗАФИКСИРОВАНО
- **Наруто**: читает `telegram:bot:incoming` (Grammy бот), отвечает через `tg-send.py` → `telegram:bot:outgoing`
- **Саске**: читает `telegram:incoming` (Telethon user account), отвечает через `tg-send-user.py` → `telegram:outgoing`
- Доставка сообщений — через watchdog-сервисы (systemd), /loop НЕ нужен и НЕ запускается
- CLAUDE.md обновлён, содержит корректное описание транспортов

### Konoha Bus
- HTTP API: http://127.0.0.1:3200, внешний эндпойнт https://agent.eaprelsky.ru:8080/konoha/
- Nginx reverse proxy, SSL Let's Encrypt (expires 2026-06-23)
- Все агенты: naruto, sasuke (+ itachi, shikamaru offline)

### telegram-bot-service
- Grammy бот @eaprelsky_agent_bot, `/home/ubuntu/telegram-bot-service/bot.ts`
- Скачивание файлов в /opt/shared/attachments/
- Start: `cd /home/ubuntu/telegram-bot-service && bun run bot.ts`

### Hooks (/home/ubuntu/scripts/hooks/)
- suggest-compact.js, pre-compact.js, session-start.sh, session-end.sh
- Настроены в ~/.claude/settings.json
- TODO: проверить что работают корректно

### bus.py фикс (2026-03-26, сессия Саске)
- `send_message` в `outgoing_loop` (строка 165) — добавлен `parse_mode=None`
- Причина: Telethon по умолчанию применял Markdown, экранировал `!` как `\!`
- Статус: подтверждено Егором, работает

### whitelisted_groups (2026-03-26)
- Добавлена группа "coMind развитие" (-1003742722362) — по запросу Егора

### TODO
- [ ] Проверить работу hooks (suggest-compact, pre-compact, session-start/end)
