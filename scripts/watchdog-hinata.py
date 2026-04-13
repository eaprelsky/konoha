#!/usr/bin/env python3
"""
Watchdog for Hinata (Claude Agent #6, QA Runner).
Watches Konoha SSE stream /messages/hinata/stream.
Delivers run commands from Shino to hinata tmux session when agent is idle.

On-demand agent: starts agent-hinata.service if session is absent.
Trigger messages: hinata:run smoke, hinata:run regression plan=<path>, hinata:stop
"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

_b.AGENT_ID          = "hinata"
_b.TMUX_SESSION      = "hinata"
_b.DEBOUNCE_WINDOW   = 2.0
_b.IDLE_TIMEOUT_SEC  = 1800   # 30 min — full test runs can be long
_b.WAKE_TIMEOUT_SEC  = 120    # on-demand: start if session absent
_b.BATCH_HEADER      = "Задание для Хинаты:"
_b.BATCH_FOOTER      = "Выполни задание согласно AGENTS.md. Результат сообщи в Коноха."

if __name__ == "__main__":
    asyncio.run(_b.run_watchdog())
