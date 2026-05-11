#!/usr/bin/env python3
"""Compatibility wrapper: GitHub/Konoha architecture delegation for Shikadai."""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

os.environ.setdefault("AGENT_ID", "shikadai")
os.environ.setdefault("AGENT_DISPLAY_NAME", "Шикадай")
os.environ.setdefault("AGENT_TMUX_SESSION", "shikadai")
os.environ.setdefault("AGENT_WAKE_TIMEOUT_SEC", "180")
os.environ.setdefault("AGENT_GITHUB_DELEGATION_LABELS", "delegate:architect")
os.environ.setdefault("AGENT_GITHUB_REDISPATCH_LABELS", "shikadai-batch,architect-batch")
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
_b.DESYNC_RECOVERY_ENABLED = False  # 53257306: Codex detection not tuned — suppress restart loop

if __name__ == "__main__":
    main()
