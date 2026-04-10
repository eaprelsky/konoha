#!/usr/bin/env python3
"""
Watchdog for Ino (Claude Agent #12, Marketing).
Watches Konoha SSE stream /messages/ino/stream.
Delivers trigger messages to ino tmux session when agent is idle.

Trigger messages: ino:smoke, ino:regression, ino:plan <component>, ino:analyze <file>
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

_b.AGENT_ID         = "ino"
_b.TMUX_SESSION     = "ino"
_b.DEBOUNCE_WINDOW  = 3.0   # longer — test triggers shouldn't batch
_b.IDLE_TIMEOUT_SEC = 600   # 10 min — tests take longer
_b.BATCH_HEADER     = "Новые задания из Коноха:"
_b.BATCH_FOOTER     = "Выполни задание согласно CLAUDE.md. Результат сообщи в Коноха."
_b.BATCH_SEPARATOR  = "\n"

if __name__ == "__main__":
    asyncio.run(_b.run_watchdog())
