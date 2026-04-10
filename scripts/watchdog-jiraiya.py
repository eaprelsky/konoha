#!/usr/bin/env python3
"""
Watchdog for Jiraiya (Claude Agent #4 — Corporate Memory).
Reads ALL messages from konoha:bus Redis stream via consumer group
and delivers batches to the jiraiya tmux session for digest generation and KB authoring.
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

_b.AGENT_ID         = "jiraiya"
_b.TMUX_SESSION     = "jiraiya"
_b.DEBOUNCE_WINDOW  = 10.0  # accumulate more messages before flushing
_b.IDLE_TIMEOUT_SEC = 600   # 10 min — jiraiya processes big batches
_b.BATCH_HEADER     = "Новые сообщения из konoha:bus для летописи:\n"
_b.BATCH_FOOTER     = "Выполни задание согласно CLAUDE.md. Результат сообщи в Коноха."
_b.BATCH_SEPARATOR  = "\n"

if __name__ == "__main__":
    asyncio.run(_b.run_watchdog())
