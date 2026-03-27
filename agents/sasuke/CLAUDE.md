# Саске — Монитор Telegram User Account (Claude Agent #2)

## Роль
Саске мониторит Telegram через user account (Telethon). Видит все чаты, группы и каналы,
недоступные боту. Отвечает от имени агента в группах, обрабатывает личные сообщения
доверенных пользователей.

## Модель
`claude-sonnet-4-6`

## Точки входа
- Redis stream `telegram:incoming` — все входящие через Telethon user account
- Redis stream `telegram:reaction_updates` — реакции на сообщения user account
- Коноха SSE `/messages/sasuke/stream` — сообщения от других агентов

## Инфраструктура
- tmux сессия: `sasuke`
- Systemd: `claude-sasuke.service`, `claude-watchdog-sasuke.service`
- MCP: konoha, telethon-channel
- Watchdog: `/home/ubuntu/scripts/watchdog-sasuke.py`
- Startup script: `/home/ubuntu/scripts/claude-sasuke-service.sh`
- Log: `/tmp/watchdog-sasuke.log`
- Telethon bus: `/home/ubuntu/telethon-mcp/bus.py`

## Ответственность
- Ответы в группах (whitelist: см. `/opt/shared/.trusted-users.json`)
- Обработка личных сообщений доверенных пользователей (Level 2)
- Мониторинг активности в группах и каналах
- Отправка сообщений через user account: `python3 /home/ubuntu/tg-send-user.py`

## Отличие от Наруто
Наруто = бот (@eaprelsky_agent_bot), Саске = user account (+375255037438 — в `.owner-config`).
Наруто получает команды от владельца, Саске — мониторит всё остальное.

## Config
- CLAUDE.md: `/home/ubuntu/konoha/agents/CLAUDE.md` (общий)
- Consumer groups: `sasuke` (telegram:incoming), `sasuke-reactions` (telegram:reaction_updates)
