#!/usr/bin/env python3
"""Compatibility wrapper: GitHub/Konoha architecture delegation for Shikadai."""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

os.environ.setdefault("AGENT_ID", "shikadai")
os.environ.setdefault("AGENT_DISPLAY_NAME", "Шикадай")
os.environ.setdefault("AGENT_TMUX_SESSION", "shikadai")
os.environ.setdefault("AGENT_WAKE_TIMEOUT_SEC", "180")
os.environ.setdefault("AGENT_GITHUB_DELEGATION_LABELS", "agent:shikadai")
# #793 canonical taxonomy: agent:shikadai drives review dispatch.
os.environ.setdefault("AGENT_GITHUB_REDISPATCH_LABELS", "")
os.environ.setdefault("AGENT_GITHUB_TASK_VERB", "analyze")
os.environ.setdefault(
    "AGENT_GITHUB_TASK_TEMPLATE",
    "shikadai:analyze issue={number} title={title}",
)
os.environ.setdefault("AGENT_BATCH_HEADER", "Архитектурное задание для Шикадая:")
os.environ.setdefault(
    "AGENT_BATCH_FOOTER",
    "Сделай архитектурную декомпозицию согласно AGENTS.md. Не меняй код и не закрывай issue без явного запроса.",
)

from github_delegation_watchdog import *  # noqa: F401,F403,E402

import watchdog_base as _b
_b.DESYNC_RECOVERY_ENABLED = True
_b.IDLE_TIMEOUT_SEC = int(os.environ.get("SHIKADAI_IDLE_TIMEOUT_SEC", "600"))

if __name__ == "__main__":
    main()
