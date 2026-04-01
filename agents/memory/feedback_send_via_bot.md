---
name: Send messages via bot, not user account
description: Отправлять сообщения через telegram:bot:outgoing (бот-сервис), а не telegram:outgoing (Telethon user account)
type: feedback
---

Отправлять сообщения Егору через бота (@eaprelsky_agent_bot), а не через user account (@eaclaude).

**Why:** tg-send.py писал в telegram:outgoing (Telethon/bus.py), сообщения приходили в чат Саске (user account), а не в чат с ботом. Егор попросил продублировать в чат с ботом (2026-03-25).

**How to apply:** Использовать `python3 /home/ubuntu/tg-send.py <chat_id> '<text>' [reply_to]` — скрипт обновлён, пишет в `telegram:bot:outgoing`. Бот-сервис (telegram-bot-service) слушает этот stream и отправляет через Grammy API.
