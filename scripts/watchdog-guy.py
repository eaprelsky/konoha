#!/usr/bin/env python3
"""
Watchdog for Guy (Claude Agent #10, Kakashi's sub-agent).
Watches Konoha SSE stream /messages/guy/stream.
Delivers task commands from Kakashi to guy tmux session when agent is idle.

Trigger messages: guy:task type=translate ..., guy:task type=scaffold ..., etc.
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

_b.AGENT_ID         = "guy"
_b.TMUX_SESSION     = "guy"
_b.DEBOUNCE_WINDOW  = 2.0
_b.IDLE_TIMEOUT_SEC = 600   # 10 min — tasks should be fast
_b.BATCH_HEADER     = "Task from Kakashi:"
_b.BATCH_FOOTER     = "Execute the task and report back to Kakashi via konoha_send(to=kakashi, ...)."
_b.BATCH_SEPARATOR  = "\n"

if __name__ == "__main__":
    asyncio.run(_b.run_watchdog())
