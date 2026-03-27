#!/usr/bin/env python3
"""
Watchdog for Itachi (local WSL Claude agent).
Connects to REMOTE Konoha bus and delivers messages to local terminal.

Installation on WSL:
  pip3 install -r requirements.txt  (none needed, uses stdlib + curl)
  export KONOHA_URL=https://agent.eaprelsky.ru
  export KONOHA_TOKEN=<your_token>
  python3 watchdog-itachi.py

  Or as background: nohup python3 watchdog-itachi.py &

Delivery modes (auto-detected):
  1. tmux session "itachi" exists → send-keys (same as server watchdogs)
  2. No tmux → print message + bell to stderr so it appears in terminal

Config via env vars:
  KONOHA_URL     — Konoha bus URL (default: https://agent.eaprelsky.ru)
  KONOHA_TOKEN   — auth token
  ITACHI_AGENT   — agent ID on Konoha (default: itachi)
  ITACHI_TMUX    — tmux session name (default: itachi)
  DEBOUNCE_SEC   — debounce window in seconds (default: 2.0)
"""

import asyncio
import json
import logging
import os
import subprocess
import sys
import time

# ── Config ──────────────────────────────────────────────────────────────────
KONOHA_URL   = os.environ.get("KONOHA_URL",  "https://agent.eaprelsky.ru")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
AGENT_ID     = os.environ.get("ITACHI_AGENT", "itachi")
TMUX_SESSION = os.environ.get("ITACHI_TMUX",  "itachi")

DEBOUNCE_WINDOW  = float(os.environ.get("DEBOUNCE_SEC", "2.0"))
IDLE_POLL_SEC    = 2.0
IDLE_TIMEOUT_SEC = 300
SSE_MAX_BACKOFF  = 60

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger(__name__)


# ── Delivery helpers ──────────────────────────────────────────────────────────

def tmux_session_exists(session: str) -> bool:
    try:
        r = subprocess.run(
            ["tmux", "has-session", "-t", session],
            capture_output=True, timeout=3
        )
        return r.returncode == 0
    except Exception:
        return False


def tmux_pane_content(session: str) -> str:
    try:
        return subprocess.check_output(
            ["tmux", "capture-pane", "-pt", session], timeout=3
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


async def deliver_via_tmux(session: str, text: str) -> None:
    await tmux_run("tmux", "send-keys", "-t", session, text)
    await asyncio.sleep(0.3)
    await tmux_run("tmux", "send-keys", "-t", session, "Enter")
    log.info(f"Sent to tmux:{session} ({len(text)} chars)")


def deliver_via_print(text: str) -> None:
    """Print message with bell to stderr so it appears in current terminal."""
    print("\a", file=sys.stderr, end="", flush=True)   # bell
    print("\n" + "="*60, file=sys.stderr)
    print("[Konoha] New message for Itachi:", file=sys.stderr)
    print(text, file=sys.stderr)
    print("="*60 + "\n", file=sys.stderr)


# ── Message formatting ────────────────────────────────────────────────────────

def format_batch(events: list[dict]) -> str:
    lines = ["Новые сообщения в шине Коноха:"]
    for ev in events:
        d = ev.get("data", ev)
        sender = d.get("from", "?")
        text   = d.get("text", "")
        ts     = d.get("timestamp", "")
        lines.append(f"\n[{ts[:16] if ts else ''}] {sender}: {text}")
    lines.append("\nОбработай и при необходимости ответь через konoha_send.")
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

        prompt = format_batch(pending)
        pending.clear()

        if tmux_session_exists(TMUX_SESSION):
            # Wait for idle, then send via tmux
            waited = 0.0
            while True:
                if is_agent_idle(TMUX_SESSION):
                    break
                if waited >= IDLE_TIMEOUT_SEC:
                    log.warning(f"Agent busy >{IDLE_TIMEOUT_SEC}s — delivering anyway")
                    break
                await asyncio.sleep(IDLE_POLL_SEC)
                waited += IDLE_POLL_SEC
            try:
                await deliver_via_tmux(TMUX_SESSION, prompt)
            except Exception as e:
                log.error(f"tmux send failed: {e}, falling back to print")
                deliver_via_print(prompt)
        else:
            # No tmux — print to stderr with bell
            deliver_via_print(prompt)


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
        log.info(f"Debounced {len(batch)} event(s)")
        await batched_queue.put(batch)


# ── Konoha SSE watcher ────────────────────────────────────────────────────────

async def konoha_sse_watcher(raw_queue: asyncio.Queue) -> None:
    url = f"{KONOHA_URL}/messages/{AGENT_ID}/stream"
    backoff = 1

    while True:
        proc = None
        try:
            log.info(f"Connecting to {url}")
            # Pass env without proxy for local connections; for remote, just use default
            env = {**os.environ}
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "-N",
                "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                "--retry", "0",
                "--max-time", "0",   # no timeout — SSE is long-lived
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
                        log.info(f"Message from {data.get('from','?')}: {data.get('text','')[:80]}")
                        await raw_queue.put({"source": "konoha", "data": data})
                    except json.JSONDecodeError:
                        pass

            rc = await proc.wait()
            log.warning(f"Connection closed (code {rc}), retrying in {backoff}s")

        except asyncio.CancelledError:
            if proc:
                proc.kill()
            raise
        except Exception as e:
            log.warning(f"Error: {e!r}, retrying in {backoff}s")
        finally:
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                except Exception:
                    pass

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, SSE_MAX_BACKOFF)


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    if not KONOHA_TOKEN:
        print("ERROR: KONOHA_TOKEN env var not set", file=sys.stderr)
        print("Usage:", file=sys.stderr)
        print("  export KONOHA_URL=https://agent.eaprelsky.ru", file=sys.stderr)
        print("  export KONOHA_TOKEN=<token>", file=sys.stderr)
        print("  python3 watchdog-itachi.py", file=sys.stderr)
        sys.exit(1)

    log.info(f"Watchdog starting: agent={AGENT_ID}, tmux={TMUX_SESSION}")
    log.info(f"Konoha URL: {KONOHA_URL}")
    log.info(f"Delivery: {'tmux:'+TMUX_SESSION if tmux_session_exists(TMUX_SESSION) else 'stderr print'}")

    raw_queue     = asyncio.Queue()
    batched_queue = asyncio.Queue()

    await asyncio.gather(
        konoha_sse_watcher(raw_queue),
        debouncer(raw_queue, batched_queue),
        send_loop(batched_queue),
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped.")
