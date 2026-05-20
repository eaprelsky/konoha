#!/usr/bin/env python3
"""
Universal watchdog — replaces all per-agent watchdog-*.py scripts.

Usage:
  watchdog.py --agent naruto
  watchdog.py --config /path/to/config.json

Config is loaded from agent-configs/{agent}.json when --agent is used.

Modules extracted from this file (#573):
  watchdog_tmux.py   — tmux helpers, idle detection, tmux_send
  watchdog_format.py — noise filter, batch formatting
  watchdog_sources.py — event source watchers (SSE, TG, Redis, GitHub)
"""

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from watchdog_tmux import is_session_alive, is_agent_idle, tmux_send
from watchdog_format import format_batch
from kiba_monitor_profile import label_kiba_message, target_environment_from_env
from watchdog_sources import (
    konoha_sse_watcher,
    telegram_queue_watcher,
    reaction_queue_watcher,
    telegram_redis_watcher,
    redis_reactions_watcher,
    github_issues_scanner,
    get_health,
)

# ── Environment ───────────────────────────────────────────────────────────────

KONOHA_URL   = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")

IDLE_POLL_SEC = 2.0

# Module-level logger (reconfigured in main after config is loaded)
log = logging.getLogger(__name__)


# ── Logging setup ─────────────────────────────────────────────────────────────

class _FlushFileHandler(logging.FileHandler):
    """FileHandler that flushes after each record — prevents log buffering on restart."""
    def emit(self, record):
        super().emit(record)
        self.flush()


def _setup_logging(agent_id: str) -> None:
    log_file = f"/tmp/watchdog-{agent_id}.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            _FlushFileHandler(log_file),
            logging.StreamHandler(),
        ],
    )


# ── Freeze alert ──────────────────────────────────────────────────────────────

async def send_freeze_alert(session: str, waited: float, n_msgs: int) -> None:
    """Alert Kiba when agent has been unresponsive past idle_timeout."""
    payload = json.dumps({
        "from": f"watchdog-{session}",
        "to": "kiba",
        "text": label_kiba_message(
            f"kiba:alert agent={session} frozen timeout={int(waited)}s msgs_dropped={n_msgs}",
            target_environment_from_env(),
        ),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "-X", "POST",
            "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
            "-H", "Content-Type: application/json",
            "-d", payload,
            f"{KONOHA_URL}/messages",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
        await asyncio.wait_for(proc.wait(), timeout=10)
        log.warning(f"Freeze alert sent to kiba: agent={session} waited={int(waited)}s")
    except Exception as e:
        log.error(f"Failed to send freeze alert: {e}")


# ── Send loop ─────────────────────────────────────────────────────────────────

async def send_loop(batched_queue: asyncio.Queue, cfg: dict) -> None:
    """Wait for agent idle, then flush the pending batch."""
    session      = cfg["tmux_session"]
    idle_timeout = cfg.get("idle_timeout", 600)
    agent_id     = cfg["agent_id"]
    pending: list[dict] = []

    # Kakashi-specific: don't wake agent for scan-only batches when busy
    is_kakashi = "github-issues" in cfg.get("sources", [])

    while True:
        try:
            timeout = 1.0 if pending else None
            batch = await asyncio.wait_for(batched_queue.get(), timeout=timeout)
            pending.extend(batch)
        except asyncio.TimeoutError:
            pass

        if not pending:
            continue

        # Don't wake agent for scan-only batches if busy (Kakashi behaviour)
        all_scans = is_kakashi and all(
            (ev.get("data", ev).get("text", "") == f"{agent_id}:scan")
            for ev in pending
        )

        waited = 0.0
        while True:
            if is_agent_idle(session):
                break
            if waited >= idle_timeout:
                if all_scans:
                    log.info(f"{agent_id} busy — dropping scan-only batch")
                else:
                    log.warning(f"Agent {session} busy >{idle_timeout}s — dropping {len(pending)} msgs")
                    await send_freeze_alert(session, waited, len(pending))
                pending.clear()
                break
            await asyncio.sleep(IDLE_POLL_SEC)
            waited += IDLE_POLL_SEC

        if pending:
            try:
                prompt = format_batch(pending, cfg)
                delivered = await tmux_send(session, prompt)
                if delivered is True:
                    get_health()["last_delivered_at"] = asyncio.get_running_loop().time()
                    pending.clear()
                elif delivered is False:
                    log.warning(f"tmux_send unconfirmed — clearing {len(pending)} msg(s)")
                    pending.clear()
                else:
                    # delivered is None — text never reached buffer
                    log.warning(f"tmux_send failed before buffer — retrying {len(pending)} msg(s) on next idle")
            except Exception as e:
                log.error(f"tmux send failed: {e}")
                pending.clear()


# ── Debouncer ─────────────────────────────────────────────────────────────────

async def debouncer(raw_queue: asyncio.Queue, batched_queue: asyncio.Queue, cfg: dict) -> None:
    """Accumulate events for debounce_window seconds, then pass as a batch."""
    debounce_window = cfg.get("debounce_window", 2.0)
    loop = asyncio.get_running_loop()
    while True:
        msg = await raw_queue.get()
        batch = [msg]
        deadline = loop.time() + debounce_window
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                extra = await asyncio.wait_for(raw_queue.get(), timeout=remaining)
                batch.append(extra)
            except asyncio.TimeoutError:
                break
        log.info(f"Debounced {len(batch)} event(s) → batched_queue")
        await batched_queue.put(batch)


# ── Heartbeat ─────────────────────────────────────────────────────────────────

async def _send_lifecycle(text: str, env: dict, agent_id: str) -> None:
    """Broadcast a lifecycle event (SESSION_ONLINE/OFFLINE) to all agents."""
    payload = json.dumps({
        "from": f"watchdog-{agent_id}",
        "to": "all",
        "text": text,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "-X", "POST",
            "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
            "-H", "Content-Type: application/json",
            "-d", payload,
            f"{KONOHA_URL}/messages",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
        await asyncio.wait_for(proc.wait(), timeout=10)
        log.info(f"Lifecycle broadcast: {text}")
    except Exception as e:
        log.warning(f"Failed to broadcast lifecycle: {e}")


async def heartbeat_loop(cfg: dict) -> None:
    """Send heartbeat while the managed tmux session is alive."""
    agent_id = cfg["agent_id"]
    session = cfg.get("tmux_session", agent_id)
    url = f"{KONOHA_URL}/agents/{agent_id}/heartbeat"
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    was_active = is_session_alive(session)
    while True:
        try:
            is_active = is_session_alive(session)
        except Exception as e:
            log.warning(f"Could not check tmux session {session}: {e}")
            is_active = True  # fail open — assume active

        if is_active:
            if not was_active:
                await _send_lifecycle(f"SESSION_ONLINE:{agent_id}", env, agent_id)
            try:
                proc = await asyncio.create_subprocess_exec(
                    "curl", "-s", "-X", "POST",
                    "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                    url,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=env,
                )
                await proc.wait()
                log.debug("Heartbeat sent")
            except Exception as e:
                log.warning(f"Heartbeat failed: {e}")
        else:
            log.info(f"tmux session {session} inactive — skipping heartbeat")
            if was_active:
                await _send_lifecycle(f"SESSION_OFFLINE:{agent_id}", env, agent_id)

        was_active = is_active
        await asyncio.sleep(300)  # every 5 min


# ── Health monitor ────────────────────────────────────────────────────────────

async def health_monitor(cfg: dict) -> None:
    """
    Detects stuck delivery: if a message was received but not delivered within
    stuck_timeout seconds, log error and exit (systemd Restart=always will
    restart the watchdog cleanly).
    """
    idle_timeout = cfg.get("idle_timeout", 600)
    stuck_timeout = idle_timeout + 120
    await asyncio.sleep(30)  # grace period on startup
    while True:
        await asyncio.sleep(30)
        now = asyncio.get_running_loop().time()
        h = get_health()
        last_rx = h["last_received_at"]
        last_tx = h["last_delivered_at"]
        if last_rx > 0 and (now - last_rx) > stuck_timeout and last_tx < last_rx:
            log.error(
                f"Health monitor: message received {now - last_rx:.0f}s ago but not delivered "
                f"(last_rx={last_rx:.0f}, last_tx={last_tx:.0f}) — restarting watchdog"
            )
            sys.exit(1)


# ── Config loading ────────────────────────────────────────────────────────────

def load_config(args: argparse.Namespace) -> dict:
    if args.config:
        config_path = Path(args.config)
    elif args.agent:
        script_dir = Path(__file__).parent
        config_path = script_dir / "agent-configs" / f"{args.agent}.json"
    else:
        raise RuntimeError("Must specify --agent or --config")

    if not config_path.exists():
        raise FileNotFoundError(f"Config not found: {config_path}")

    with open(config_path) as f:
        cfg = json.load(f)

    for key in ("agent_id", "tmux_session", "sources"):
        if key not in cfg:
            raise ValueError(f"Config missing required key: {key}")

    return cfg


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    parser = argparse.ArgumentParser(description="Universal Konoha agent watchdog")
    parser.add_argument("--agent", help="Agent name (loads agent-configs/{agent}.json)")
    parser.add_argument("--config", help="Path to config JSON file")
    args = parser.parse_args()

    cfg = load_config(args)
    agent_id = cfg["agent_id"]
    sources  = cfg.get("sources", [])

    _setup_logging(agent_id)

    if not KONOHA_TOKEN:
        raise RuntimeError("KONOHA_TOKEN env var not set")

    log.info(f"Watchdog starting for agent={agent_id}, session={cfg['tmux_session']}, sources={sources}")

    raw_queue     = asyncio.Queue()
    batched_queue = asyncio.Queue()

    coros = []

    # Core pipeline — always present
    coros.append(konoha_sse_watcher(raw_queue, cfg))
    coros.append(debouncer(raw_queue, batched_queue, cfg))
    coros.append(send_loop(batched_queue, cfg))
    coros.append(heartbeat_loop(cfg))

    # Optional sources
    if "telegram-file" in sources:
        if "telegram_file" not in cfg:
            log.warning("Source 'telegram-file' requested but 'telegram_file' key missing in config — skipping")
        else:
            coros.append(telegram_queue_watcher(raw_queue, cfg))

    if "telegram-reactions-file" in sources:
        if "reaction_file" not in cfg:
            log.warning("Source 'telegram-reactions-file' requested but 'reaction_file' key missing in config — skipping")
        else:
            coros.append(reaction_queue_watcher(raw_queue, cfg))

    if "redis-stream" in sources:
        if "redis_stream" not in cfg:
            log.warning("Source 'redis-stream' requested but 'redis_stream' key missing in config — skipping")
        else:
            coros.append(telegram_redis_watcher(raw_queue, cfg))

    if "redis-reactions" in sources:
        if "reaction_stream" not in cfg:
            log.warning("Source 'redis-reactions' requested but 'reaction_stream' key missing in config — skipping")
        else:
            coros.append(redis_reactions_watcher(raw_queue, cfg))

    if "github-issues" in sources:
        if "github" not in cfg:
            log.warning("Source 'github-issues' requested but 'github' key missing in config — skipping")
        else:
            coros.append(github_issues_scanner(raw_queue, cfg))

    # Health monitor — always present
    coros.append(health_monitor(cfg))

    await asyncio.gather(*coros)


if __name__ == "__main__":
    asyncio.run(main())
