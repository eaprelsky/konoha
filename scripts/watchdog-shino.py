#!/usr/bin/env python3
"""
Watchdog for Shino (Claude Agent #5, QA Lead).
Watches Konoha SSE stream /messages/shino/stream.
Delivers trigger messages to shino tmux session when agent is idle.

On-demand agent: starts claude-shino.service if session is absent.
Trigger messages: shino:smoke, shino:regression, shino:plan <component>, shino:analyze <file>
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

_b.AGENT_ID          = "shino"
_b.TMUX_SESSION      = "shino"
_b.DEBOUNCE_WINDOW   = 3.0    # longer — test triggers shouldn't batch
_b.IDLE_TIMEOUT_SEC  = 600    # 10 min — tests take longer
_b.WAKE_TIMEOUT_SEC  = 120    # on-demand: start if session absent
_b.BATCH_HEADER      = "Задание для Шино:"
_b.BATCH_FOOTER      = "Выполни задание согласно AGENTS.md. Результат сообщи в Коноха."

if __name__ == "__main__":
    asyncio.run(_b.run_watchdog())
