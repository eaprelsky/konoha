#!/usr/bin/env python3
"""
Watchdog for Ibiki (Claude Agent #9, Security Pentester).
Watches Konoha SSE stream /messages/ibiki/stream.
Delivers trigger messages to ibiki tmux session when agent is idle.

Trigger messages: ibiki:scan, ibiki:audit component=<name>
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

_b.AGENT_ID         = "ibiki"
_b.TMUX_SESSION     = "ibiki"
_b.DEBOUNCE_WINDOW  = 5.0   # longer debounce — batch multiple triggers
_b.IDLE_TIMEOUT_SEC = 600   # 10 min — security scans take longer
_b.BATCH_HEADER     = "Задание для Ибики:"
_b.BATCH_FOOTER     = "Выполни задание согласно CLAUDE.md."
_b.BATCH_SEPARATOR  = "\n"

if __name__ == "__main__":
    asyncio.run(_b.run_watchdog())
