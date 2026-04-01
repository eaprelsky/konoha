---
name: Sasuke messaging decisions
description: Sasuke reads telegram:incoming, replies via tg-send-user.py (telegram:outgoing). Naruto owns bot streams. Разделение зафиксировано 2026-03-25.
type: project
---

## Финальная архитектура (2026-03-25, обновлено сессия 10)

**Sasuke (Agent #2):**
- Читает: `telegram:incoming` (Telethon user account) → consumer group `sasuke`, consumer `sasuke-worker`
- Отвечает: `python3 /home/ubuntu/tg-send-user.py <chat_id> '<text>'` → `telegram:outgoing` (Telethon)
- Обрабатывает: все сообщения от Егора (is_group=0 тоже), упоминания в группах

**Naruto (Agent #1):**
- Читает: `telegram:bot:incoming` (Grammy бот @eaprelsky_agent_bot)
- Отвечает: `tg-send.py` → `telegram:bot:outgoing`
- Обрабатывает: личные сообщения Егора, задачи, оркестрация

**Why:** Программное разделение каналов — каждый агент читает/пишет только свой транспорт независимо от инструкций. Yegor потребовал 2026-03-25 после того как Саске отвечал через бота.

**How to apply:**
- НЕ читать telegram:bot:incoming (канал Наруто)
- НЕ использовать tg-send.py (это бот, канал Наруто)
- НЕ использовать tg_read_new (конкурировало с consumer group)
- ВСЕГДА отвечать через tg-send-user.py → telegram:outgoing
