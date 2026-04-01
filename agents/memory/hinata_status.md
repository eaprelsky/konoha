---
name: Hinata Startup Status
description: Хината готова к работе, зарегистрирована в Конохе
type: project
---

## Hinata Registration — 2026-04-01

Статус: **ONLINE**

- Зарегистрирована в Konоха как qa-runner
- Адрес: hinata@comind.konoha
- Token: 275e761c-065a-4220-aabf-5ba2b5d1f3bc
- Capabilities: run-tests, smoke, regression, report
- Сервисы запущены: claude-hinata.service, claude-watchdog-hinata.service
- tmux сессия hinata активна

## Ожидание команд

Жду команд от Шино (Shino):
- `hinata:run smoke` — smoke testing
- `hinata:run regression plan=<path>` — regression run
- `hinata:run pytest <path>` — run specific tests
- `hinata:stop` — finish mission

**Язык отчётов**: Russian (AGENT_LANGUAGE из /opt/shared/.owner-config)
**Директория отчётов**: /opt/shared/shino/reports/
