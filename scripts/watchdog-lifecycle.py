#!/usr/bin/env python3
"""
Generic watchdog for lifecycle-managed agents (launched via Konoha API).
Watches Konoha SSE stream for a given agent_id and delivers messages
to tmux session konoha-{agent_id} on the default socket.

Usage: watchdog-lifecycle.py <agent_id> [agent_id2 ...]
Or: WATCHDOG_AGENTS=shino,kiba,hinata watchdog-lifecycle.py
"""

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime

# ── Config ──────────────────────────────────────────────────────────────────
KONOHA_URL   = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")

DEBOUNCE_WINDOW  = 2.0
IDLE_POLL_SEC    = 2.0
IDLE_TIMEOUT_SEC = 300
SSE_MAX_BACKOFF  = 30

LOG_FILE = "/tmp/watchdog-lifecycle.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("watchdog-lifecycle")


def get_agents() -> list[str]:
    """Get list of agent IDs to watch."""
    if len(sys.argv) > 1:
        return sys.argv[1:]
    env = os.environ.get("WATCHDOG_AGENTS", "")
    if env:
        return [a.strip() for a in env.split(",") if a.strip()]
    return []


def tmux_session(agent_id: str) -> str:
    return f"konoha-{agent_id}"


def is_agent_idle(agent_id: str) -> bool:
    """Check if agent's tmux session shows the ❯ prompt (idle)."""
    session = tmux_session(agent_id)
    try:
        result = subprocess.run(
            ["tmux", "capture-pane", "-t", session, "-p"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return False
        lines = result.stdout.strip().split("\n")
        for line in reversed(lines[-5:]):
            stripped = line.strip()
            if stripped.startswith("❯") and len(stripped) < 5:
                return True
        return False
    except Exception:
        return False


def is_session_alive(agent_id: str) -> bool:
    """Check if tmux session exists on default socket."""
    session = tmux_session(agent_id)
    try:
        result = subprocess.run(
            ["tmux", "has-session", "-t", session],
            capture_output=True, timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


async def tmux_send(agent_id: str, text: str) -> bool:
    """Send text to agent's tmux session via send-keys."""
    session = tmux_session(agent_id)
    try:
        proc = await asyncio.create_subprocess_exec(
            "tmux", "send-keys", "-t", session, text,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5)
        if proc.returncode != 0:
            return False
        proc2 = await asyncio.create_subprocess_exec(
            "tmux", "send-keys", "-t", session, "Enter",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc2.wait(), timeout=5)
        return True
    except Exception as e:
        log.error(f"tmux_send({agent_id}) error: {e}")
        return False


async def watch_agent(agent_id: str):
    """Watch Konoha SSE for a single agent and deliver messages."""
    import aiohttp

    url = f"{KONOHA_URL}/messages/{agent_id}/stream"
    headers = {"Authorization": f"Bearer {KONOHA_TOKEN}"}
    backoff = 1

    log.info(f"[{agent_id}] Starting SSE watcher → {tmux_session(agent_id)}")

    while True:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=None)) as resp:
                    if resp.status != 200:
                        log.warning(f"[{agent_id}] SSE HTTP {resp.status}, retrying in {backoff}s")
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, SSE_MAX_BACKOFF)
                        continue

                    backoff = 1
                    log.info(f"[{agent_id}] SSE connected")

                    pending: list[str] = []
                    last_event_time = 0.0

                    async for line in resp.content:
                        text = line.decode("utf-8", errors="replace").strip()
                        if not text:
                            continue

                        if text.startswith("data: "):
                            data_str = text[6:]
                            try:
                                msg = json.loads(data_str)
                            except json.JSONDecodeError:
                                continue

                            # Format message
                            ts = msg.get("timestamp", "")[:19] or datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
                            sender = msg.get("from", "?")
                            body = msg.get("text", "")
                            if not body:
                                continue

                            formatted = f"[{ts}] {sender}: {body}"
                            pending.append(formatted)
                            last_event_time = time.monotonic()

                        # Debounce: deliver batch when no new events for DEBOUNCE_WINDOW
                        if pending and (time.monotonic() - last_event_time) >= DEBOUNCE_WINDOW:
                            batch = "\n".join(pending)
                            prompt = f"Новые сообщения в шине Коноха:\n{batch}\n\nОбработай и при необходимости ответь через konoha_send."

                            # Wait for agent to be idle
                            waited = 0.0
                            while not is_agent_idle(agent_id):
                                if not is_session_alive(agent_id):
                                    log.warning(f"[{agent_id}] session dead, dropping {len(pending)} msgs")
                                    pending.clear()
                                    break
                                await asyncio.sleep(IDLE_POLL_SEC)
                                waited += IDLE_POLL_SEC
                                if waited > IDLE_TIMEOUT_SEC:
                                    log.warning(f"[{agent_id}] busy >{IDLE_TIMEOUT_SEC}s, dropping {len(pending)} msgs")
                                    pending.clear()
                                    break

                            if pending:
                                ok = await tmux_send(agent_id, prompt)
                                if ok:
                                    log.info(f"[{agent_id}] delivered {len(pending)} msg(s)")
                                else:
                                    log.error(f"[{agent_id}] tmux_send failed")
                                pending.clear()

                        # Small sleep to allow debounce check
                        await asyncio.sleep(0.1)

        except asyncio.CancelledError:
            break
        except Exception as e:
            log.error(f"[{agent_id}] SSE error: {e}, retrying in {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, SSE_MAX_BACKOFF)


async def main():
    agents = get_agents()
    if not agents:
        # Auto-discover: get all non-protected agents from Konoha API
        import aiohttp
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{KONOHA_URL}/agents",
                    headers={"Authorization": f"Bearer {KONOHA_TOKEN}"},
                ) as resp:
                    data = await resp.json()
                    all_agents = data if isinstance(data, list) else data.get("agents", [])
                    # Watch agents that have lifecycle and are not system (naruto/sasuke have own watchdogs)
                    system_ids = {"naruto", "sasuke", "mirai", "kakashi"}
                    agents = [
                        a["id"] for a in all_agents
                        if a.get("id") and a["id"] not in system_ids
                        and a.get("lifecycle", {}).get("status") == "running"
                    ]
        except Exception as e:
            log.error(f"Auto-discover failed: {e}")
            return

    if not agents:
        log.warning("No agents to watch. Exiting.")
        return

    log.info(f"Watching {len(agents)} agents: {agents}")
    tasks = [asyncio.create_task(watch_agent(aid)) for aid in agents]
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
