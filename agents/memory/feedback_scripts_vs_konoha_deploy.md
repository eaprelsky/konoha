---
name: scripts deploy path
description: Agent scripts now run directly from /home/ubuntu/konoha/scripts/ — no duplicate deploy mirror
type: feedback
---

Canonical runtime path:

- `/home/ubuntu/konoha/scripts/<name>.py` — repo checkout and runtime path for deployed scripts

How to apply now:

- Patch the file in `/home/ubuntu/konoha/scripts/`
- Restart the relevant service

Historical note: older deployments also kept a duplicate mirror in `/home/ubuntu/scripts/`, but that mirror was removed during the 2026-04-13 cleanup.
