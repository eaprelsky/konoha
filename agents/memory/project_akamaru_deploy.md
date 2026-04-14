---
name: Akamaru deploy path
description: akamaru.service runs directly from /home/ubuntu/konoha/scripts/akamaru.py
type: project
---

Akamaru runs from `/home/ubuntu/konoha/scripts/akamaru.py`.

How to apply:

- Patch `/home/ubuntu/konoha/scripts/akamaru.py`
- Restart `akamaru.service`

Historical note: older deployments used a duplicated copy under `/home/ubuntu/scripts/`, but that mirror was removed during the 2026-04-13 cleanup.
