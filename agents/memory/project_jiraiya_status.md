---
name: Jiraiya agent status — paused by Yegor
description: Jiraiya (Agent #4, Chronicler) остановлен по запросу Егора. НЕ запускать — требует перепроектирования перед следующим запуском.
type: project
---

Дзирайя (claude-jiraiya.service + claude-watchdog-jiraiya.service) остановлен по явному запросу Егора 2026-04-01.

**Why:** Егор решил остановить Дзирайю до перепроектирования архитектуры (текущая версия недостаточно полезна). Параллельно планируется апгрейд RAM сервера claudea до 8Gi. Запускать Дзирайю до завершения редизайна не нужно.

**How to apply:** НЕ запускать claude-jiraiya.service, claude-watchdog-jiraiya.service и не создавать tmux-сессию "jiraiya" без явного разрешения Егора. Если Кибе или другому агенту покажется, что сессия "упала" — это норма, перезапускать не нужно.
