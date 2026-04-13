#!/usr/bin/env python3
"""
Watchdog for Inojin (Claude Agent #13, Marketing).
Watches Konoha SSE stream /messages/inojin/stream.
Delivers trigger messages to inojin tmux session when agent is idle.

Trigger messages: inojin:smoke, inojin:regression, inojin:plan <component>, inojin:analyze <file>
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

_b.AGENT_ID         = "inojin"
_b.TMUX_SESSION     = "inojin"
_b.DEBOUNCE_WINDOW  = 3.0   # longer — test triggers shouldn't batch
_b.IDLE_TIMEOUT_SEC = 600   # 10 min — tests take longer
_b.BATCH_HEADER     = "Новые задания из Коноха:"
_b.BATCH_FOOTER     = "Выполни задание согласно AGENTS.md. Результат сообщи в Коноха."
_b.BATCH_SEPARATOR  = "\n"

if __name__ == "__main__":
    asyncio.run(_b.run_watchdog())
