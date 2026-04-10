#!/usr/bin/env python3
"""
Watchdog for Mirai (Claude Agent #3).
Subscribes to Konoha SSE stream and delivers messages to Mirai's tmux session
only when she's idle. Batches rapid-fire events into a single prompt.

Fallback: cron-loop in Mirai's session (every 5–10 min) catches anything missed.
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

_b.AGENT_ID         = "mirai"
_b.TMUX_SESSION     = "mirai"
_b.DEBOUNCE_WINDOW  = 2.0   # accumulate events before flushing
_b.IDLE_TIMEOUT_SEC = 300   # 5 min — give up if agent hung
_b.BATCH_HEADER     = "Новые сообщения в шине Коноха:"
_b.BATCH_FOOTER     = "Обработай и при необходимости ответь через konoha_send."
_b.BATCH_SEPARATOR  = "\n"

if __name__ == "__main__":
    asyncio.run(_b.run_watchdog())
