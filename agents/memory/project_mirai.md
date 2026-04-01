---
name: Mirai agent architecture
description: Mirai (Мирай) - Agent #3, Haiku-based Claude Code session in tmux, event-driven via watchdog
type: project
---

Mirai (Мирай) — третий агент Конохи. Женское имя, дочь Асумы и Курэнай из вселенной Боруто.

**Текущая архитектура:** Постоянная Claude Code headless сессия в tmux `mirai`, модель claude-haiku-4-5-20251001.
- systemd: `claude-mirai.service` — запускает Claude Code в tmux
- MCP: `/home/ubuntu/telethon-mcp/.mcp-mirai.json` (konoha + email)
- Token: `cfd606b5-bc5f-431b-8db5-542b63fdc146`

**Watchdog:** `claude-watchdog-mirai.service` (всегда запущен)
- Слушает Коноха SSE `/messages/mirai/stream`
- Доставляет события в tmux `mirai` когда агент idle
- Log: `/tmp/watchdog-mirai.log`
- Нет /loop — event-driven через watchdog

**Роль:** Пограничник — обрабатывает внешние данные (почта, CRM) и передаёт суть Наруто и Саске.

**Why:** Haiku дешевле и быстрее для рутинных задач. Разделение: Наруто - управление, Саске - группы, Мирай - внешние потоки.

**How to apply:** Обращаться к Мирай в женском роде. Мирай уже работает как постоянный Claude Code агент с IMAP-доступом.
