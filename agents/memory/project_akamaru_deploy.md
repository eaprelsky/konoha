---
name: Akamaru deploy path vs git repo
description: systemd запускает /home/ubuntu/scripts/akamaru.py, git-репо в /home/ubuntu/konoha/scripts/akamaru.py — это разные файлы
type: project
---

Akamaru запускается systemd из /home/ubuntu/scripts/akamaru.py (деплой-копия).
Git-репо находится в /home/ubuntu/konoha/scripts/akamaru.py.

**Why:** В issue #76 оказалось, что фикс e117fe8 был применён в git-репо, но не в деплой-файле. systemd продолжал запускать старую версию.

**How to apply:** При любых фиксах akamaru.py — проверять и обновлять оба файла, затем перезапускать akamaru.service. В идеале настроить деплой из репо.
