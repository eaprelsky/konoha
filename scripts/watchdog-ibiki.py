#!/usr/bin/env python3
"""
Watchdog for Ibiki (Claude Agent #9, Security Pentester).
Watches Konoha SSE stream /messages/ibiki/stream.
Delivers trigger messages to ibiki tmux session when agent is idle.

Trigger messages: ibiki:scan, ibiki:audit component=<name>
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
import subprocess
import time

# ── Config ──────────────────────────────────────────────────────────────────
KONOHA_URL   = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
AGENT_ID     = "ibiki"
TMUX_SESSION = "ibiki"

DEBOUNCE_WINDOW  = 5.0   # longer debounce — batch multiple triggers
IDLE_POLL_SEC    = 2.0
IDLE_TIMEOUT_SEC = 600   # 10 min — security scans take longer
SSE_MAX_BACKOFF  = 60

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
    def has_prompt(content: str) -> bool:
        lines = [l.strip() for l in content.strip().split("\n")]
        return any(
            (l == "❯" or l == "❯\xa0" or l.startswith("❯ ") or l.startswith("❯\xa0"))
            and "Pasted text" not in l
            for l in lines[-6:]
        )
    for _ in range(stable_checks):
        if not has_prompt(tmux_pane_content(session)):
            return False
        if stable_checks > 1:
            time.sleep(1.0)
    return True


# ── tmux send ────────────────────────────────────────────────────────────────

async def tmux_run(*args: str, timeout: float = 10.0) -> bool:
    """Run a tmux command. Returns True on success, False on timeout (#51)."""
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
    ok = await tmux_run("tmux", "send-keys", "-t", session, text, timeout=5.0)
    if not ok:
        log.error(f"send-keys timed out for {session} — skipping delivery")
        return
    await asyncio.sleep(0.3)
    await tmux_run("tmux", "send-keys", "-t", session, "Enter", timeout=5.0)
    log.info(f"Sent prompt to {session} ({len(text)} chars)")
    await asyncio.sleep(2.0)  # give agent more time to start processing
    for attempt in range(3):
        content_after = tmux_pane_content(session)
        if content_after != content_before:
            log.info(f"Delivery confirmed: pane content changed after send")
            break  # pane changed — agent received the message (#50)
        if not is_agent_idle(session, stable_checks=2):
            break  # agent is processing — good
        log.warning(f"Pane unchanged and agent idle (attempt {attempt+1}), resending full prompt")
        await tmux_run("tmux", "send-keys", "-t", session, "C-u", timeout=5.0)
        ok = await tmux_run("tmux", "send-keys", "-t", session, text, timeout=5.0)
        if not ok:
            log.error(f"Resend attempt {attempt+1} timed out for {session}")
            break
        await asyncio.sleep(0.3)
        await tmux_run("tmux", "send-keys", "-t", session, "Enter", timeout=5.0)
        await asyncio.sleep(2.0)


# ── Message formatting ────────────────────────────────────────────────────────

def format_batch(events: list[dict]) -> str:
    lines = ["Задание для Ибики:"]
    for ev in events:
        d = ev.get("data", ev)
        sender = d.get("from", "?")
        text   = d.get("text", "")
        ts     = d.get("timestamp", "")
        lines.append(f"\n[{ts[:16] if ts else ''}] {sender}: {text}")
    lines.append("\nВыполни задание согласно CLAUDE.md.")
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


# ── Heartbeat ─────────────────────────────────────────────────────────────────

async def heartbeat_loop() -> None:
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
        await asyncio.sleep(300)


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    if not KONOHA_TOKEN:
        raise RuntimeError("KONOHA_TOKEN env var not set")

    log.info(f"Watchdog starting for agent={AGENT_ID}, session={TMUX_SESSION}")

    raw_queue     = asyncio.Queue()
    batched_queue = asyncio.Queue()

    await asyncio.gather(
        konoha_sse_watcher(raw_queue),
        debouncer(raw_queue, batched_queue),
        send_loop(batched_queue),
        heartbeat_loop(),
    )


if __name__ == "__main__":
    asyncio.run(main())
