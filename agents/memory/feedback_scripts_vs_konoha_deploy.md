---
name: scripts vs konoha deploy paths
description: Deployed agent scripts in /home/ubuntu/scripts/ differ from git repo in /home/ubuntu/konoha/scripts/ — always fix both
type: feedback
---

When fixing bugs in agent scripts (akamaru, watchdogs, etc.), there are TWO separate copies:

- `/home/ubuntu/konoha/scripts/<name>.py` — git repo (source of truth for commits)
- `/home/ubuntu/scripts/<name>.py` — deployed copy actually run by systemd services

**Why:** Deploy is not automated; files are copied manually. They can diverge.

**How to apply:** When fixing any script in `/home/ubuntu/konoha/scripts/`, ALWAYS also check and update `/home/ubuntu/scripts/` if the file exists there. Then restart the relevant systemd service. Discovered during #75/#76: fix applied to git repo didn't affect the running akamaru.service.
