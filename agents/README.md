# Команда агентов Конохи

Многоагентная система на базе Claude Code. Агенты общаются через [Коноха-шину](../README.md),
получают задачи через watchdog-сервисы и работают автономно.

## Состав команды

| # | Агент | Модель | Роль | tmux | Статус |
|---|-------|--------|------|------|--------|
| 1 | [Наруто](naruto/CLAUDE.md) | Sonnet | Главный оркестратор, Telegram бот | `naruto` | Постоянный |
| 2 | [Саске](sasuke/CLAUDE.md) | Sonnet | Telegram user account монитор | `sasuke` | Постоянный |
| 3 | [Мирай](mirai/CLAUDE.md) | Haiku | Email и данные | `mirai` | Постоянный |
| 4 | [Дзирайя](jiraiya/CLAUDE.md) | Sonnet | Летописец — классифицирует и архивирует события | `jiraiya` | Постоянный |
| 5 | [Шино](shino/CLAUDE.md) | Sonnet | QA Lead — тест-планы, координация тестирования | `shino` | Постоянный |
| 6 | [Хината](hinata/CLAUDE.md) | Haiku | QA Runner — прогон тестов, отчёты | `hinata` | Постоянный |
| 7 | [Киба](kiba/CLAUDE.md) | Sonnet | Страж системы — мониторинг, алерты | `kiba` | Постоянный |
| 8 | [Какаши](kakashi/CLAUDE.md) | Sonnet | Баг-фиксер — читает GitHub Issues, чинит код | `kakashi` | Постоянный |
| — | [Итачи](itachi/CLAUDE.md) | Sonnet+ | Локальный агент WSL (на машине владельца) | `itachi` | Опциональный |
| — | Шикамару | Opus | Советник владельца (Windows Claude Desktop, без тулзов) | — | Внешний |
| — | Акамару | Python | Автономный мониторинг (не Claude, скрипт) | — | Постоянный |

## Архитектура доставки сообщений

```
Telegram Bot API ──► message-queue.jsonl ──► watchdog-naruto ──► tmux naruto
Telegram Telethon ──► Redis telegram:incoming ──► watchdog-sasuke ──► tmux sasuke
Konoha SSE ──► watchdog-{agent} ──► tmux {agent}
GitHub Issues ──► watchdog-kakashi ──► tmux kakashi
Akamaru alerts ──► Konoha ──► watchdog-kiba ──► tmux kiba
```

## Коноха-шина

- HTTP API: `http://127.0.0.1:3200` (локально), `https://agent.eaprelsky.ru` (внешний)
- Агент получает сообщения через SSE: `GET /messages/{id}/stream`
- Агент отправляет: `POST /messages` `{"from": "id", "to": "id", "text": "..."}`
- MCP инструменты: `konoha_send`, `konoha_read`, `konoha_agents`, `konoha_register`

## Хранилище

| Путь | Назначение |
|------|-----------|
| `/opt/shared/agent-memory/` | Общая память всех агентов (38+ файлов) |
| `/opt/shared/jiraiya/` | Летопись: media/, internal/, private/ |
| `/opt/shared/shino/` | QA: plans/, reports/, bugs/ |
| `/opt/shared/kiba/` | Мониторинг: logs/, reports/ |
| `/opt/shared/attachments/` | Файлы из Telegram |

## Systemd сервисы

Каждый постоянный агент имеет два сервиса:
- `claude-{agent}.service` — запускает Claude Code в tmux
- `claude-watchdog-{agent}.service` — доставляет события агенту

Дополнительно: `akamaru.service` — автономный мониторинг здоровья системы.

## Добавление нового агента

1. Создай `agents/{name}/CLAUDE.md` с описанием роли
2. Создай `agents/{name}/.mcp-{name}.json` по шаблону `agents/.mcp-template.json`
3. Создай `scripts/claude-{name}-service.sh` и `scripts/watchdog-{name}.py`
4. Создай systemd unit-файлы и включи их
5. Добавь агента в эту таблицу
6. Добавь сессию в `WATCHED_SESSIONS` в `scripts/akamaru.py`
