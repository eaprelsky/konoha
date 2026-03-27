#!/usr/bin/env python3
"""
Watchdog for Naruto (Claude Agent #1).
Watches two sources in parallel:
  1. ~/.claude/channels/telegram/message-queue.jsonl  (tail -F)
  2. Konoha SSE stream /messages/naruto/stream

When events arrive, batches them (2s debounce window) and sends to the
naruto tmux session only when the agent is idle (❯ prompt visible).

Fallback: cron-loop in Naruto's session catches anything missed.
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
import subprocess
import time
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
KONOHA_URL    = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN  = os.environ.get("KONOHA_TOKEN", "")
AGENT_ID      = "naruto"
TMUX_SESSION  = "naruto"

MESSAGE_QUEUE   = Path(os.path.expanduser("~/.claude/channels/telegram/message-queue.jsonl"))
REACTION_QUEUE  = Path(os.path.expanduser("~/.claude/channels/telegram/reaction-queue.jsonl"))

DEBOUNCE_WINDOW  = 2.0   # seconds to accumulate events before flushing
IDLE_POLL_SEC    = 2.0   # how often to check if agent is idle
IDLE_TIMEOUT_SEC = 300   # give up waiting after 5 min (agent hung?)
SSE_MAX_BACKOFF  = 60    # seconds

# SESSION_ONLINE/OFFLINE are system noise — never deliver to agent
NOISE_TEXT_PREFIXES = ("SESSION_ONLINE:", "SESSION_OFFLINE:")
NOISE_TEXT_CONTAINS = ("going offline (session end)",)

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


def is_session_noise(data: dict) -> bool:
    """Return True for SESSION_ONLINE/OFFLINE noise events that should be dropped."""
    text = data.get("text", "")
    return (
        any(text.startswith(p) for p in NOISE_TEXT_PREFIXES) or
        any(s in text for s in NOISE_TEXT_CONTAINS)
    )


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

async def tmux_run(*args: str, timeout: float = 10.0) -> bool:
    """Run a tmux command asynchronously. Returns True on success, False on timeout (#51)."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        proc.kill()
        log.warning(f"tmux command timed out: {' '.join(str(a) for a in args)}")
        return False


async def tmux_send(session: str, text: str) -> None:
    # Collapse newlines to spaces — multi-line text triggers Claude Code [Pasted text] dialog
    text = text.replace("\n", " ").replace("\r", " ")
    # Capture pane content BEFORE send to detect delivery confirmation (#50)
    content_before = tmux_pane_content(session)
    # send-keys without -l: simulates typing (no paste mode, no [Pasted text] indicator)
    ok = await tmux_run("tmux", "send-keys", "-t", session, text, timeout=5.0)
    if not ok:
        log.error(f"send-keys timed out for {session} — skipping delivery")
        return
    await asyncio.sleep(0.3)
    await tmux_run("tmux", "send-keys", "-t", session, "Enter", timeout=5.0)
    log.info(f"Sent prompt to {session} ({len(text)} chars)")

    # Dismiss [Pasted text] confirmation dialog if it appeared
    for _ in range(5):
        content = tmux_pane_content(session)
        if "Pasted text" in content:
            log.warning(f"[Pasted text] dialog detected in {session} — sending Enter to confirm")
            await tmux_run("tmux", "send-keys", "-t", session, "Enter")
            await asyncio.sleep(1.0)
        else:
            break
    await asyncio.sleep(2.0)  # give agent more time to start processing
    for attempt in range(3):
        content_after = tmux_pane_content(session)
        if content_after != content_before:
            log.info(f"Delivery confirmed: pane content changed after send")
            break  # pane changed — agent received the message (#50)
        if not is_agent_idle(session, stable_checks=2):
            break  # agent is processing — good
        log.warning(f"Pane unchanged and agent idle (attempt {attempt+1}), resending full prompt")
        ok = await tmux_run("tmux", "send-keys", "-t", session, text, timeout=5.0)
        if not ok:
            log.error(f"Resend attempt {attempt+1} timed out for {session}")
            break
        await asyncio.sleep(0.3)
        await tmux_run("tmux", "send-keys", "-t", session, "Enter", timeout=5.0)
        await asyncio.sleep(2.0)


# ── Message formatting ────────────────────────────────────────────────────────

def format_batch(events: list[dict]) -> str:
    """Convert a batch of events into a single prompt for the agent."""
    tg_events      = [e for e in events if e.get("source") == "telegram"]
    konoha_events  = [e for e in events if e.get("source") == "konoha"]
    reaction_events = [e for e in events if e.get("source") == "reaction"]

    # Deduplicate: Konoha TG-bridge echoes look like "[TG Sender] text"
    # If we already have the TG event directly, skip its Konoha echo to avoid duplicate replies
    tg_texts = {(ev.get("data", ev).get("text") or "").strip() for ev in tg_events}
    konoha_deduped = []
    for ev in konoha_events:
        d = ev.get("data", ev)
        konoha_text = (d.get("text") or "").strip()
        sender = d.get("from", "")
        # Skip Konoha echo if it's "[TG ...] <same text>" and we have TG event directly
        if sender == "telegram":
            for tg_text in tg_texts:
                if tg_text and tg_text in konoha_text:
                    log.info(f"Deduped Konoha echo of TG message: {konoha_text[:60]}")
                    break
            else:
                konoha_deduped.append(ev)
        else:
            konoha_deduped.append(ev)

    lines = []

    if tg_events:
        lines.append("Новые сообщения в Telegram:")
        for ev in tg_events:
            d = ev.get("data", ev)
            sender = d.get("user_name") or d.get("user", "?")
            text = d.get("text", "")
            ts = d.get("ts", "")[:16] if d.get("ts") else ""
            lines.append(f"\n[{ts}] {sender}: {text}")
        lines.append("\nОбработай и ответь через tg-send.py.")

    if konoha_deduped:
        if lines:
            lines.append("")
        lines.append("Новые сообщения в шине Коноха:")
        for ev in konoha_deduped:
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
            emoji = d.get("new_reaction", "?")
            user = d.get("user", "?")
            msg_id = d.get("message_id", "?")
            ts = d.get("ts", "")[:16]
            lines.append(f"\n[{ts}] {user} поставил {emoji} на сообщение {msg_id}")
        lines.append("\nМожешь отреагировать через tg_react если нужно, или просто прими к сведению.")

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

        # Wait until agent is idle
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
        "from": "watchdog-naruto",
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
    """Accumulate events for DEBOUNCE_WINDOW seconds, then pass as a batch."""
    loop = asyncio.get_running_loop()
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
    """Read Konoha SSE stream via curl subprocess."""
    url = f"{KONOHA_URL}/messages/{AGENT_ID}/stream"
    backoff = 1

    while True:
        proc = None
        try:
            log.info(f"SSE connecting via curl to {url}")
            env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
            proc = await asyncio.create_subprocess_exec(
                "curl",
                "-s", "-N",
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
                        if is_session_noise(data):
                            log.debug(f"Skipping SESSION noise: {data.get('text','')[:50]}")
                            continue
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


# ── Telegram message-queue.jsonl watcher ──────────────────────────────────────

async def telegram_queue_watcher(raw_queue: asyncio.Queue) -> None:
    """
    Tail message-queue.jsonl and emit new messages.
    Tracks last seen message_id to avoid replaying old messages on restart.
    """
    last_id_file = Path(f"/tmp/watchdog-{AGENT_ID}-last-tg-id")

    # Read last known message_id
    last_id = 0
    if last_id_file.exists():
        try:
            last_id = int(last_id_file.read_text().strip())
        except Exception:
            pass

    # On first run, seed last_id from the current end of the file (don't replay history)
    if last_id == 0 and MESSAGE_QUEUE.exists():
        try:
            lines = MESSAGE_QUEUE.read_text().strip().splitlines()
            if lines:
                last_line = json.loads(lines[-1])
                last_id = int(last_line.get("message_id", 0))
                last_id_file.write_text(str(last_id))
                log.info(f"Seeded last Telegram message_id={last_id}")
        except Exception as e:
            log.warning(f"Could not seed last_id: {e}")

    log.info(f"Watching {MESSAGE_QUEUE}, last_id={last_id}")

    backoff = 1
    while True:
        try:
            if not MESSAGE_QUEUE.exists():
                await asyncio.sleep(5)
                continue

            # Read all lines, find new ones
            lines = MESSAGE_QUEUE.read_text().strip().splitlines()
            new_events = []
            for line in lines:
                try:
                    msg = json.loads(line)
                    mid = int(msg.get("message_id", 0))
                    if mid > last_id and msg.get("action_hint") in ("respond", "observe"):
                        new_events.append(msg)
                        if mid > last_id:
                            last_id = mid
                except Exception:
                    pass

            if new_events:
                last_id_file.write_text(str(last_id))
                for msg in new_events:
                    log.info(f"TG message from {msg.get('user','?')}: {msg.get('text','')[:60]}")
                    await raw_queue.put({"source": "telegram", "data": msg})

            backoff = 1
            await asyncio.sleep(1.0)  # poll every second

        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning(f"TG watcher error: {e!r}, retrying in {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ── Telegram reaction-queue.jsonl watcher ─────────────────────────────────────

async def reaction_queue_watcher(raw_queue: asyncio.Queue) -> None:
    """Watch reaction-queue.jsonl and deliver new reactions."""
    last_id_file = Path(f"/tmp/watchdog-{AGENT_ID}-last-react-ts")

    last_ts = ""
    if last_id_file.exists():
        last_ts = last_id_file.read_text().strip()

    # Seed from current end of file
    if not last_ts and REACTION_QUEUE.exists():
        try:
            lines = REACTION_QUEUE.read_text().strip().splitlines()
            if lines:
                last_ts = json.loads(lines[-1]).get("ts", "")
                last_id_file.write_text(last_ts)
                log.info(f"Seeded last reaction ts={last_ts}")
        except Exception as e:
            log.warning(f"Could not seed reaction ts: {e}")

    while True:
        try:
            if not REACTION_QUEUE.exists():
                await asyncio.sleep(5)
                continue

            lines = REACTION_QUEUE.read_text().strip().splitlines()
            new_reactions = []
            new_last_ts = last_ts
            for line in lines:
                try:
                    r = json.loads(line)
                    ts = r.get("ts", "")
                    if ts > last_ts and r.get("new_reaction"):
                        new_reactions.append(r)
                        if ts > new_last_ts:
                            new_last_ts = ts
                except Exception:
                    pass

            if new_reactions:
                last_ts = new_last_ts
                last_id_file.write_text(last_ts)
                for r in new_reactions:
                    emoji = r.get("new_reaction", "?")
                    user = r.get("user", "?")
                    msg_id = r.get("message_id", "?")
                    log.info(f"Reaction {emoji} from {user} on msg {msg_id}")
                    await raw_queue.put({"source": "reaction", "data": r})

            await asyncio.sleep(1.0)

        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning(f"Reaction watcher error: {e!r}")
            await asyncio.sleep(5)


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
        telegram_queue_watcher(raw_queue),
        reaction_queue_watcher(raw_queue),
        debouncer(raw_queue, batched_queue),
        send_loop(batched_queue),
        heartbeat_loop(),
    )


if __name__ == "__main__":
    asyncio.run(main())
