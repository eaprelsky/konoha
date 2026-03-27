#!/usr/bin/env python3
"""
Watchdog for Jiraiya (Claude Agent #4 — Chronicler).
Reads ALL messages from konoha:bus Redis stream via consumer group
and delivers batches to the jiraiya tmux session for classification and logging.
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
import time

import redis.asyncio as aioredis

# ── Config ──────────────────────────────────────────────────────────────────
AGENT_ID      = "jiraiya"
TMUX_SESSION  = "jiraiya"

REDIS_HOST    = "127.0.0.1"
REDIS_PORT    = 6379
BUS_STREAM    = "konoha:bus"
BUS_GROUP     = "jiraiya"
BUS_CONSUMER  = "jiraiya-watchdog"

DEBOUNCE_WINDOW  = 10.0   # seconds — accumulate more messages before flushing
IDLE_POLL_SEC    = 2.0
IDLE_TIMEOUT_SEC = 600    # 10 min — jiraiya processes big batches
DIGEST_INTERVAL  = 10800  # 3 hours in seconds

LOG_FILE = f"/tmp/watchdog-{AGENT_ID}.log"

class _FlushFileHandler(logging.FileHandler):
    """FileHandler that flushes after each record — prevents log buffering on restart."""
    def emit(self, record):
        super().emit(record)
        self.flush()


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        _FlushFileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)


# ── Idle detection ───────────────────────────────────────────────────────────

def tmux_pane_content(session: str) -> str:
    import subprocess
    try:
        return subprocess.check_output(
            ["tmux", "capture-pane", "-pt", session],
            timeout=3
        ).decode("utf-8", errors="replace")
    except Exception:
        return ""


def is_agent_idle(session: str, stable_checks: int = 2) -> bool:
    def has_prompt(content: str) -> bool:
        lines = [l.strip() for l in content.strip().split("\n")]
        return any((l == "❯" or l == "❯\xa0" or l.startswith("❯ ") or l.startswith("❯\xa0")) and "Pasted text" not in l for l in lines[-6:])
    for _ in range(stable_checks):
        if not has_prompt(tmux_pane_content(session)):
            return False
        if stable_checks > 1:
            time.sleep(1.0)
    return True


# ── tmux send ────────────────────────────────────────────────────────────────

async def tmux_run(*args: str, timeout: float = 10.0) -> None:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        log.warning(f"tmux command timed out: {args}")


async def tmux_send(session: str, text: str) -> None:
    # Collapse newlines to spaces — multi-line text triggers Claude Code [Pasted text] dialog
    text = text.replace("\n", " ").replace("\r", " ")
    # send-keys without -l: simulates typing (no paste mode, no [Pasted text] indicator)
    await tmux_run("tmux", "send-keys", "-t", session, text)
    await asyncio.sleep(0.3)
    await tmux_run("tmux", "send-keys", "-t", session, "Enter")
    log.info(f"Sent prompt to {session} ({len(text)} chars)")
    await asyncio.sleep(2.0)  # give agent more time to start processing
    for attempt in range(3):
        if not is_agent_idle(session, stable_checks=2):
            break
        log.warning(f"Agent still idle after send (attempt {attempt+1}), resending full prompt")
        await tmux_run("tmux", "send-keys", "-t", session, text)
        await asyncio.sleep(0.3)
        await tmux_run("tmux", "send-keys", "-t", session, "Enter")
        await asyncio.sleep(2.0)


# ── Message formatting ────────────────────────────────────────────────────────

SKIP_TYPES = {"heartbeat", "ping", "pong"}

def format_batch(messages: list[dict]) -> str | None:
    """Format a batch of konoha:bus messages for Jiraiya."""
    # Filter out noise
    meaningful = [m for m in messages if m.get("type") not in SKIP_TYPES and m.get("text", "").strip()]
    if not meaningful:
        return None

    lines = ["Новые сообщения из konoha:bus для летописи:\n"]
    for m in meaningful:
        ts = (m.get("timestamp") or "")[:16]
        frm = m.get("from", "?")
        to = m.get("to", "?")
        typ = m.get("type", "message")
        text = m.get("text", "")
        lines.append(f"[{ts}] {frm}→{to} ({typ}): {text}")

    lines.append(f"\nВсего {len(meaningful)} сообщений (из {len(messages)} включая служебные).")
    lines.append("Классифицируй каждое (PUBLIC/INTERNAL/PRIVATE) и запиши в /opt/shared/jiraiya/.")
    return "\n".join(lines)


# ── Send loop ─────────────────────────────────────────────────────────────────

async def send_loop(batched_queue: asyncio.Queue) -> None:
    pending: list[dict] = []

    while True:
        try:
            timeout = 1.0 if pending else None
            batch = await asyncio.wait_for(batched_queue.get(), timeout=timeout)
            pending.extend(batch)
        except asyncio.TimeoutError:
            pass

        if not pending:
            continue

        waited = 0.0
        while True:
            if is_agent_idle(TMUX_SESSION):
                break
            if waited >= IDLE_TIMEOUT_SEC:
                log.warning(f"Agent {TMUX_SESSION} busy >{IDLE_TIMEOUT_SEC}s — dropping {len(pending)} msgs")
                await send_freeze_alert(TMUX_SESSION, waited, len(pending))
                pending.clear()
                break
            await asyncio.sleep(IDLE_POLL_SEC)
            waited += IDLE_POLL_SEC

        if pending:
            prompt = format_batch(pending)
            if prompt:
                try:
                    await tmux_send(TMUX_SESSION, prompt)
                except Exception as e:
                    log.error(f"tmux send failed: {e}")
            else:
                log.info(f"Skipped {len(pending)} noise-only messages")
            pending.clear()

async def send_freeze_alert(session: str, waited: float, n_msgs: int) -> None:
    """Alert Kiba when agent has been unresponsive past IDLE_TIMEOUT_SEC."""
    payload = json.dumps({
        "from": f"watchdog-{session}",
        "to": "kiba",
        "text": f"kiba:alert agent={session} frozen timeout={int(waited)}s msgs_dropped={n_msgs}",
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


# ── Debouncer ─────────────────────────────────────────────────────────────────

async def debouncer(raw_queue: asyncio.Queue, batched_queue: asyncio.Queue) -> None:
    loop = asyncio.get_event_loop()
    while True:
        msg = await raw_queue.get()
        batch = [msg]
        deadline = loop.time() + DEBOUNCE_WINDOW
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                extra = await asyncio.wait_for(raw_queue.get(), timeout=remaining)
                batch.append(extra)
            except asyncio.TimeoutError:
                break
        log.info(f"Debounced {len(batch)} bus event(s) → batched_queue")
        await batched_queue.put(batch)


# ── Digest trigger ────────────────────────────────────────────────────────────

async def digest_loop(batched_queue: asyncio.Queue) -> None:
    """Trigger a digest every DIGEST_INTERVAL seconds."""
    while True:
        await asyncio.sleep(DIGEST_INTERVAL)
        log.info("Sending digest trigger to jiraiya")
        digest_msg = [{
            "from": "watchdog",
            "to": "jiraiya",
            "type": "digest",
            "text": "DIGEST: Сгенерируй дайджест за последние 3 часа. Прочитай internal/timeline/ за сегодня, обнови patterns, при наличии фактуры создай media/stories/ нарратив.",
            "timestamp": "",
        }]
        await batched_queue.put(digest_msg)


# ── konoha:bus Redis watcher ──────────────────────────────────────────────────

async def bus_watcher(raw_queue: asyncio.Queue) -> None:
    backoff = 1
    r = None

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

            try:
                await r.xgroup_create(BUS_STREAM, BUS_GROUP, id="$", mkstream=True)
                log.info(f"Created consumer group {BUS_GROUP} on {BUS_STREAM}")
            except Exception as e:
                if "BUSYGROUP" not in str(e):
                    raise

            log.info(f"Listening on {BUS_STREAM} (group={BUS_GROUP}, consumer={BUS_CONSUMER})")
            backoff = 1

            while True:
                results = await r.xreadgroup(
                    BUS_GROUP, BUS_CONSUMER,
                    {BUS_STREAM: ">"},
                    count=50,
                    block=5000,
                )
                if not results:
                    continue

                for stream_name, messages in results:
                    for msg_id, fields in messages:
                        try:
                            log.info(f"Bus msg {msg_id}: {fields.get('from','?')}→{fields.get('to','?')} {fields.get('text','')[:50]}")
                            await raw_queue.put(dict(fields))
                            await r.xack(BUS_STREAM, BUS_GROUP, msg_id)
                        except Exception as e:
                            log.error(f"Error processing bus msg {msg_id}: {e}")

        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            log.warning(f"Bus watcher error: {e!r}, retrying in {backoff}s")
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    log.info(f"Watchdog starting for agent={AGENT_ID}, session={TMUX_SESSION}")

    raw_queue     = asyncio.Queue()
    batched_queue = asyncio.Queue()

    await asyncio.gather(
        bus_watcher(raw_queue),
        debouncer(raw_queue, batched_queue),
        send_loop(batched_queue),
        digest_loop(batched_queue),
    )


if __name__ == "__main__":
    asyncio.run(main())
