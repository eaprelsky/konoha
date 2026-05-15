#!/usr/bin/env python3
"""Compatibility wrapper: GitHub/Konoha delegation delivery for Kakashi."""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

os.environ.setdefault("AGENT_ID", "kakashi")
os.environ.setdefault("AGENT_DISPLAY_NAME", "Какаши")
os.environ.setdefault("AGENT_TMUX_SESSION", "kakashi")
os.environ.setdefault("AGENT_GITHUB_DELEGATION_LABELS", "agent:kakashi")
# #793 canonical taxonomy: agent:kakashi + state:ready-for-dev drives dispatch.
os.environ.setdefault("AGENT_GITHUB_REDISPATCH_LABELS", "")
os.environ.setdefault("AGENT_GITHUB_TASK_VERB", "fix")
os.environ.setdefault("AGENT_BATCH_HEADER", "Задание для Какаши:")

from github_delegation_watchdog import *  # noqa: F401,F403,E402

import watchdog_base as _b
_b.DESYNC_RECOVERY_ENABLED = True
_b.IDLE_TIMEOUT_SEC = int(os.environ.get("KAKASHI_IDLE_TIMEOUT_SEC", "600"))

if __name__ == "__main__":
    main()
