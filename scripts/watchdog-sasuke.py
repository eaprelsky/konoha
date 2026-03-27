#!/usr/bin/env python3
"""
Watchdog for Sasuke (Claude Agent #2).
Watches two sources in parallel:
  1. Redis stream telegram:incoming  (consumer group sasuke, consumer sasuke-worker)
  2. Konoha SSE stream /messages/sasuke/stream

When events arrive, batches them (2s debounce window) and sends to the
sasuke tmux session only when the agent is idle (❯ prompt visible).
"""

import asyncio
import json
import logging
import os
import subprocess
import time

import redis.asyncio as aioredis

# ── Config ──────────────────────────────────────────────────────────────────
KONOHA_URL    = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN  = os.environ.get("KONOHA_TOKEN", "")
AGENT_ID      = "sasuke"
TMUX_SESSION  = "sasuke"

REDIS_HOST    = "127.0.0.1"
REDIS_PORT    = 6379
TG_STREAM     = "telegram:incoming"
TG_GROUP      = "sasuke"
TG_CONSUMER   = "sasuke-watchdog"  # separate consumer so /loop fallback still works

REACTION_STREAM   = "telegram:reaction_updates"
REACTION_GROUP    = "sasuke-reactions"
REACTION_CONSUMER = "sasuke-reaction-watchdog"

DEBOUNCE_WINDOW  = 2.0   # seconds to accumulate events before flushing
IDLE_POLL_SEC    = 2.0   # how often to check if agent is idle
IDLE_TIMEOUT_SEC = 300   # give up waiting after 5 min (agent hung?)
SSE_MAX_BACKOFF  = 60    # seconds

LOG_FILE = f"/tmp/watchdog-{AGENT_ID}.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)


# ── Idle detection ───────────────────────────────────────────────────────────

def tmux_pane_content(session: str) -> str:
    try:
        return subprocess.check_output(
            ["tmux", "capture-pane", "-pt", session],
            timeout=3
        ).decode("utf-8", errors="replace")
    except Exception:
        return ""


def is_agent_idle(session: str, stable_checks: int = 2) -> bool:
    """Return True if agent shows the ❯ prompt stably (not mid-processing)."""
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
    """Run a tmux command asynchronously with timeout."""
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
    # Verify agent started processing (prompt disappeared); retry Enter if stuck
    await asyncio.sleep(1.0)
    for attempt in range(3):
        if not is_agent_idle(session, stable_checks=1):
            break  # agent is processing — good
        log.warning(f"Agent still idle after Enter (attempt {attempt+1}), retrying")
        await tmux_run("tmux", "send-keys", "-t", session, "Enter")
        await asyncio.sleep(1.0)


# ── Message formatting ────────────────────────────────────────────────────────

def format_batch(events: list[dict]) -> str:
    """Convert a batch of events into a single prompt for the agent."""
    tg_events      = [e for e in events if e.get("source") == "telegram"]
    konoha_events  = [e for e in events if e.get("source") == "konoha"]
    reaction_events = [e for e in events if e.get("source") == "reaction"]

    lines = []

    if tg_events:
        lines.append("Новые сообщения в Telegram:")
        for ev in tg_events:
            d = ev.get("data", ev)
            sender = d.get("user_name") or d.get("user", "?")
            text = d.get("text", "")
            ts = (d.get("ts") or d.get("timestamp", ""))[:16]
            lines.append(f"\n[{ts}] {sender}: {text}")
        lines.append("\nОбработай и ответь через tg-send-user.py.")

    if konoha_events:
        if lines:
            lines.append("")
        lines.append("Новые сообщения в шине Коноха:")
        for ev in konoha_events:
            d = ev.get("data", ev)
            sender = d.get("from", "?")
            text = d.get("text", "")
            ts = d.get("timestamp", "")
            lines.append(f"\n[{ts[:16] if ts else ''}] {sender}: {text}")
        lines.append("\nОбработай и при необходимости ответь через konoha_send.")

    if reaction_events:
        if lines:
            lines.append("")
        lines.append("Новые реакции в Telegram:")
        for ev in reaction_events:
            d = ev.get("data", ev)
            user = d.get("user", "?")
            new_r = d.get("new_reaction", "")
            old_r = d.get("old_reaction", "")
            msg_id = d.get("message_id", "")
            chat_id = d.get("chat_id", "")
            lines.append(f"  {user} поставил {new_r} (было: {old_r}) на сообщение {msg_id} в чате {chat_id}")
        lines.append("Учти реакции как обратную связь.")

    return "\n".join(lines)


# ── Send loop ─────────────────────────────────────────────────────────────────

async def send_loop(batched_queue: asyncio.Queue) -> None:
    """Wait for idle, then flush the pending batch."""
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
            try:
                prompt = format_batch(pending)
                await tmux_send(TMUX_SESSION, prompt)
            except Exception as e:
                log.error(f"tmux send failed: {e}")
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
        log.info(f"Debounced {len(batch)} event(s) → batched_queue")
        await batched_queue.put(batch)


# ── Konoha SSE watcher ────────────────────────────────────────────────────────

async def konoha_sse_watcher(raw_queue: asyncio.Queue) -> None:
    url = f"{KONOHA_URL}/messages/{AGENT_ID}/stream"
    backoff = 1

    while True:
        proc = None
        try:
            log.info(f"SSE connecting via curl to {url}")
            env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "-N",
                "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
            )

            backoff = 1
            buf = b""
            async for chunk in proc.stdout:  # type: ignore
                buf += chunk
                while b"\n" in buf:
                    raw_line, buf = buf.split(b"\n", 1)
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if not payload:
                        continue
                    try:
                        data = json.loads(payload)
                        log.info(f"SSE event from {data.get('from','?')}: {data.get('text','')[:60]}")
                        await raw_queue.put({"source": "konoha", "data": data})
                    except json.JSONDecodeError:
                        pass

            rc = await proc.wait()
            log.warning(f"curl exited with code {rc}, retrying in {backoff}s")

        except asyncio.CancelledError:
            if proc:
                proc.kill()
            raise
        except Exception as e:
            log.warning(f"SSE watcher error: {e!r}, retrying in {backoff}s")
        finally:
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                except Exception:
                    pass

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, SSE_MAX_BACKOFF)


# ── Telegram Redis stream watcher ─────────────────────────────────────────────

async def telegram_redis_watcher(raw_queue: asyncio.Queue) -> None:
    """
    Read telegram:incoming Redis stream via consumer group.
    Uses a separate consumer name so the /loop fallback (sasuke-worker) still works independently.
    """
    backoff = 1
    r = None

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

            # Ensure consumer group exists
            try:
                await r.xgroup_create(TG_STREAM, TG_GROUP, id="$", mkstream=True)
                log.info(f"Created consumer group {TG_GROUP} on {TG_STREAM}")
            except Exception as e:
                if "BUSYGROUP" not in str(e):
                    raise

            log.info(f"Listening on Redis stream {TG_STREAM} (group={TG_GROUP}, consumer={TG_CONSUMER})")
            backoff = 1

            while True:
                # Block up to 5s waiting for new messages
                results = await r.xreadgroup(
                    TG_GROUP, TG_CONSUMER,
                    {TG_STREAM: ">"},
                    count=10,
                    block=5000,
                )
                if not results:
                    continue

                for stream_name, messages in results:
                    for msg_id, fields in messages:
                        try:
                            text = fields.get("text", "")
                            user = fields.get("user_name") or fields.get("user", "?")
                            action = fields.get("action_hint", "")
                            if action not in ("respond", "observe"):
                                await r.xack(TG_STREAM, TG_GROUP, msg_id)
                                continue
                            log.info(f"TG Redis msg from {user}: {text[:60]}")
                            await raw_queue.put({"source": "telegram", "data": fields})
                            await r.xack(TG_STREAM, TG_GROUP, msg_id)
                        except Exception as e:
                            log.error(f"Error processing TG msg {msg_id}: {e}")

        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            log.warning(f"Redis watcher error: {e!r}, retrying in {backoff}s")
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)



# ── Reaction Redis stream watcher ─────────────────────────────────────────────

async def reaction_redis_watcher(raw_queue: asyncio.Queue) -> None:
    """Read telegram:reaction_updates Redis stream via consumer group."""
    backoff = 1
    r = None

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

            try:
                await r.xgroup_create(REACTION_STREAM, REACTION_GROUP, id="$", mkstream=True)
                log.info(f"Created consumer group {REACTION_GROUP} on {REACTION_STREAM}")
            except Exception as e:
                if "BUSYGROUP" not in str(e):
                    raise

            log.info(f"Listening on Redis stream {REACTION_STREAM} (group={REACTION_GROUP})")
            backoff = 1

            while True:
                results = await r.xreadgroup(
                    REACTION_GROUP, REACTION_CONSUMER,
                    {REACTION_STREAM: ">"},
                    count=10,
                    block=5000,
                )
                if not results:
                    continue

                for stream_name, messages in results:
                    for msg_id, fields in messages:
                        try:
                            user = fields.get("user", "?")
                            new_r = fields.get("new_reaction", "")
                            log.info(f"Reaction from {user}: {new_r}")
                            await raw_queue.put({"source": "reaction", "data": fields})
                            await r.xack(REACTION_STREAM, REACTION_GROUP, msg_id)
                        except Exception as e:
                            log.error(f"Error processing reaction {msg_id}: {e}")

        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            log.warning(f"Reaction watcher error: {e!r}, retrying in {backoff}s")
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ── Heartbeat ─────────────────────────────────────────────────────────────────

async def heartbeat_loop() -> None:
    """Send heartbeat to Konoha every 5 minutes to keep agent online."""
    url = f"{KONOHA_URL}/agents/{AGENT_ID}/heartbeat"
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    while True:
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
        await asyncio.sleep(300)  # every 5 min

# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    if not KONOHA_TOKEN:
        raise RuntimeError("KONOHA_TOKEN env var not set")

    log.info(f"Watchdog starting for agent={AGENT_ID}, session={TMUX_SESSION}")

    raw_queue     = asyncio.Queue()
    batched_queue = asyncio.Queue()

    await asyncio.gather(
        konoha_sse_watcher(raw_queue),
        telegram_redis_watcher(raw_queue),
        reaction_redis_watcher(raw_queue),
        debouncer(raw_queue, batched_queue),
        send_loop(batched_queue),
        heartbeat_loop(),
    )


if __name__ == "__main__":
    asyncio.run(main())
