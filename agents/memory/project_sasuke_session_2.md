---
name: Sasuke infrastructure facts
description: Ключевые инфраструктурные факты по Саске — транспорт, скрипты, архитектура
type: project
---

## Архитектура Саске (актуально на 2026-03-25)

**Транспорт:**
- Читает: `telegram:incoming` (Telethon user account) → consumer group `sasuke`, consumer `sasuke-worker`
- Отвечает: `python3 /home/ubuntu/tg-send-user.py <chat_id> '<text>'` → `telegram:outgoing` (Telethon)
- НЕ читает telegram:bot:incoming (это Наруто), НЕ использует tg-send.py (это бот Наруто)

**Доставка сообщений:**
- `claude-watchdog-sasuke.service` — слушает telegram:incoming (Redis consumer group) + Konoha SSE
- /loop НЕ нужен, watchdog доставляет в tmux автоматически

**Ключевые скрипты:**
- `/home/ubuntu/tg-send-user.py` — отправка через Telethon user account
- `/home/ubuntu/telethon-mcp/bus.py` — Telethon ↔ Redis transport (bus v4)

**Nginx/SSL:**
- Konoha внешний эндпойнт: https://agent.eaprelsky.ru:8080/konoha/ → localhost:3200
- SSL Let's Encrypt, expires 2026-06-23
- Config: /etc/nginx/sites-available/konoha

**Why:** Разделение транспортов зафиксировано Егором 2026-03-25. Каждый агент читает/пишет только свой канал.
**How to apply:** При любом вопросе "через что отправлять/читать" — Саске всегда через Telethon (telegram:incoming / telegram:outgoing).
