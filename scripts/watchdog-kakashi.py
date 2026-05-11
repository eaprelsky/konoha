#!/usr/bin/env python3
"""Compatibility wrapper: GitHub/Konoha delegation delivery for Kakashi."""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

os.environ.setdefault("AGENT_ID", "kakashi")
os.environ.setdefault("AGENT_DISPLAY_NAME", "Какаши")
os.environ.setdefault("AGENT_TMUX_SESSION", "kakashi")
os.environ.setdefault("AGENT_GITHUB_DELEGATION_LABELS", "delegate:teamlead")
os.environ.setdefault("AGENT_GITHUB_REDISPATCH_LABELS", "kakashi-batch")
os.environ.setdefault("AGENT_GITHUB_TASK_VERB", "fix")
os.environ.setdefault("AGENT_BATCH_HEADER", "Задание для Какаши:")

from github_delegation_watchdog import *  # noqa: F401,F403,E402

import watchdog_base as _b
_b.DESYNC_RECOVERY_ENABLED = False  # 53257306: Codex detection + tmux socket mismatch — suppress restart loop

if __name__ == "__main__":
    main()
