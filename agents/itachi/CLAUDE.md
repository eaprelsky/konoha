# Итачи — Локальный агент WSL (Claude Agent, внешний)

## Роль
Итачи — агент на локальной машине владельца (WSL / Windows). Подключается к Коноха-шине
через внешний URL. Используется для локальных задач: работа с файлами на Windows,
доступ к локальным сервисам, интеграция с локальным окружением разработки.

## Модель
Зависит от локальной установки Claude Code (обычно claude-sonnet-4-6 или claude-opus-4-6)

## Точки входа
- Коноха SSE `https://agent.eaprelsky.ru/messages/itachi/stream` — сообщения от других агентов
- Доставка через tmux сессию `itachi` (если запущен) или вывод в терминал

## Инфраструктура
- Запускается на локальной машине (WSL), не на сервере
- **Нет systemd** — запускается вручную или через `nohup`
- Watchdog: `/home/ubuntu/scripts/watchdog-itachi.py` (для запуска на WSL-машине)
- Требует: `KONOHA_URL=https://agent.eaprelsky.ru`, `KONOHA_TOKEN=<токен из .agent-env>`

## Запуск на WSL
```bash
export KONOHA_URL=https://agent.eaprelsky.ru
export KONOHA_TOKEN=<токен>
python3 watchdog-itachi.py &
claude --dangerously-skip-permissions
```

## Ответственность
- Локальные задачи на машине владельца
- Доступ к файловой системе Windows через WSL
- Запуск локальных скриптов и инструментов
- Взаимодействие с командой через Коноха-шину

## Статус
Опциональный агент — активен только когда владелец запускает его локально.
