---
name: Read ALL memory files on startup, not just MEMORY.md
description: On startup must read every memory file and look for pending tasks/unfinished work before doing anything else
type: feedback
---

При старте сессии ОБЯЗАТЕЛЬНО прочитать ВСЕ файлы памяти (не только MEMORY.md), и ОСОБЕННО changelog и project файлы — искать незавершённые задачи (строки со "Статус: ожидает рестарта" и подобное).

**Why:** В сессии 7 (2026-03-25) не вспомнил задачу из сессии 6 — проверить push notifications после фикса. Задача была прямо написана в project_naruto_channel_changelog.md, но файл не был прочитан при старте. Егор был недоволен.

**How to apply:** Сразу после чтения CLAUDE.md и MEMORY.md — прочитать каждый файл из индекса. Найти все строки "Статус:", "TODO", "ожидает рестарта", "после рестарта". Составить список задач и начать их выполнять ДО запуска polling loops.
