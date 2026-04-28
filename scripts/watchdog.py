#!/usr/bin/env python3
"""
Universal watchdog — replaces all per-agent watchdog-*.py scripts.

Usage:
  watchdog.py --agent naruto
  watchdog.py --config /path/to/config.json

Config is loaded from agent-configs/{agent}.json when --agent is used.
"""

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import time

# ── Environment ───────────────────────────────────────────────────────────────

KONOHA_URL   = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
GH_TOKEN     = os.environ.get("GH_TOKEN", "")
REDIS_HOST   = os.environ.get("REDIS_HOST", "127.0.0.1")
REDIS_PORT   = int(os.environ.get("REDIS_PORT", "6379"))

IDLE_POLL_SEC   = 2.0
SSE_MAX_BACKOFF = 60

# SESSION_ONLINE/OFFLINE are system noise — never deliver to agent
NOISE_TEXT_PREFIXES = ("SESSION_ONLINE:", "SESSION_OFFLINE:")
NOISE_TEXT_CONTAINS = ("going offline (session end)",)

# Delivery state tracker (for health monitor — used by sasuke)
_health: dict = {
    "last_received_at": 0.0,
    "last_delivered_at": 0.0,
}

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


# ── Noise filter ──────────────────────────────────────────────────────────────

def is_session_noise(data: dict) -> bool:
    """Return True for SESSION_ONLINE/OFFLINE noise events that should be dropped."""
    text = data.get("text", "")
    return (
        any(text.startswith(p) for p in NOISE_TEXT_PREFIXES) or
        any(s in text for s in NOISE_TEXT_CONTAINS)
    )


# ── Idle detection ───────────────────────────────────────────────────────────

def tmux_pane_capture(session: str) -> tuple[bool, str]:
    if not is_session_alive(session):
        return False, ""
    try:
        result = subprocess.run(
            ["tmux", "-L", session, "capture-pane", "-pt", session],
            capture_output=True, timeout=3,
        )
        if result.returncode != 0:
            return False, ""
        return True, result.stdout.decode("utf-8", errors="replace")
    except Exception:
        return False, ""


def tmux_pane_content(session: str) -> str:
    return tmux_pane_capture(session)[1]


def is_session_alive(session: str) -> bool:
    """Check if tmux session exists on its named socket."""
    try:
        result = subprocess.run(
            ["tmux", "-L", session, "has-session", "-t", session],
            capture_output=True, timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def is_agent_idle(session: str, stable_checks: int = 2) -> bool:
    """Return True if agent shows a stable ready-for-input prompt (Claude/Codex/Cursor)."""
    def has_prompt(content: str) -> bool:
        lines = [l.strip() for l in content.strip().split("\n") if l.strip()]
        last_lines = lines[-12:]
        has_claude_queue = any("queued messages" in l.lower() for l in last_lines)
        has_claude_prompt = any(
            (l == "❯" or l == "❯\xa0" or l.startswith("❯ ") or l.startswith("❯\xa0"))
            and "Pasted text" not in l
            for l in last_lines
        ) and not has_claude_queue
        has_codex_startup = any("Booting MCP server" in l or "Starting MCP servers" in l for l in last_lines)
        has_codex_prompt = any(l.startswith("› ") for l in last_lines) and not has_codex_startup
        has_cursor_ready = (
            any("→ Add a follow-up" in l for l in last_lines)
            or any("ctrl+c to stop" in l for l in last_lines)
            or any("▶︎ Auto-run everything" in l for l in last_lines)
        )
        return has_claude_prompt or has_codex_prompt or has_cursor_ready
    for _ in range(stable_checks):
        alive, content = tmux_pane_capture(session)
        if not alive or not has_prompt(content):
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


async def tmux_send(session: str, text: str) -> bool:
    # Collapse newlines to spaces — multi-line text triggers Claude Code [Pasted text] dialog
    text = text.replace("\n", " ").replace("\r", " ")
    # Wait for compacting to finish before sending — avoids [Pasted text] race (#147)
    compacting_waited = 0
    while compacting_waited < 120:
        if not is_session_alive(session):
            log.error(f"Delivery failed: tmux session {session} is missing before send")
            return False
        if is_agent_idle(session, stable_checks=1):
            break
        last_lines = chr(10).join(tmux_pane_content(session).strip().split(chr(10))[-6:])
        if not any(kw in last_lines for kw in ("Compacting", "Churned for", "✻")):
            break
        log.info(f"Agent {session} compacting — waiting (waited {compacting_waited}s)")
        await asyncio.sleep(2.0)
        compacting_waited += 2
    if compacting_waited >= 120:
        log.warning(f"Agent {session} still compacting after 120s — proceeding anyway")
    elif compacting_waited > 0:
        log.info(f"Compacting done after {compacting_waited}s — proceeding")
        await asyncio.sleep(1.0)  # small buffer after compacting ends

    async def dismiss_pasted_dialog() -> None:
        for _ in range(5):
            alive, pane = tmux_pane_capture(session)
            if not alive:
                return
            if "Pasted text" not in pane:
                return
            log.warning(f"[Pasted text] dialog detected in {session} — sending Enter")
            await tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter", timeout=5.0)
            await asyncio.sleep(0.6)


    async def retype_prompt() -> bool:
        await tmux_run("tmux", "-L", session, "send-keys", "-t", session, "C-u", timeout=5.0)
        await asyncio.sleep(0.15)
        ok_local = await tmux_run("tmux", "-L", session, "send-keys", "-t", session, text, timeout=5.0)
        if not ok_local:
            log.error(f"Retype timed out for {session}")
            return False
        await asyncio.sleep(0.35)
        await dismiss_pasted_dialog()
        return True

    async def wait_for_submit(timeout_sec: float) -> bool:
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            alive, pane = tmux_pane_capture(session)
            if not alive:
                log.error(f"Delivery failed: tmux session {session} disappeared during submit")
                return False
            if "Pasted text" in pane:
                log.warning(f"[Pasted text] dialog appeared after submit in {session} — sending Enter")
                await tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter", timeout=5.0)
                await asyncio.sleep(0.6)
                continue
            if pane.strip() and not is_agent_idle(session, stable_checks=1):
                log.info("Delivery confirmed: agent left idle state after submit")
                return True
            await asyncio.sleep(0.4)
        return False


    ok = await tmux_run("tmux", "-L", session, "send-keys", "-t", session, text, timeout=5.0)
    if not ok:
        log.error(f"send-keys timed out for {session} — skipping delivery")
        return False
    await asyncio.sleep(0.5)
    await dismiss_pasted_dialog()

    for attempt in range(4):
        if attempt == 1:
            log.warning("Agent stayed idle after submit attempt 1 — retrying Enter")
        elif attempt >= 2:
            log.warning(f"Agent stayed idle after submit attempt {attempt} — clearing input and retyping prompt")
            if not await retype_prompt():
                return False

        await tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter", timeout=5.0)
        log.info(f"Sent prompt to {session} ({len(text)} chars), submit attempt {attempt + 1}")
        if await wait_for_submit(4.0 if attempt == 0 else 3.0):
            return True

    log.error(f"Delivery failed: agent {session} stayed idle after submit retries")
    return False


# ── Message formatting ────────────────────────────────────────────────────────

def format_batch(events: list[dict], cfg: dict) -> str:
    """Convert a batch of events into a single prompt for the agent.

    For naruto and sasuke (sources include telegram/redis/reactions), uses rich
    multi-section formatting.  For all other agents, uses simple prefix/suffix
    wrapping defined in config.
    """
    agent_id = cfg["agent_id"]
    prefix   = cfg.get("message_prefix", "")
    suffix   = cfg.get("message_suffix", "")

    # Naruto: telegram-file + konoha-sse + reactions
    if "telegram-file" in cfg.get("sources", []) or "telegram-reactions-file" in cfg.get("sources", []):
        return _format_naruto_batch(events)

    # Sasuke: redis-stream + konoha-sse + redis-reactions
    if "redis-stream" in cfg.get("sources", []) or "redis-reactions" in cfg.get("sources", []):
        return _format_sasuke_batch(events)

    # Generic: prefix / event lines / suffix
    lines = []
    if prefix:
        lines.append(prefix)
    for ev in events:
        d = ev.get("data", ev)
        sender = d.get("from", "?")
        text   = d.get("text", "")
        ts     = d.get("timestamp", "")
        lines.append(f"[{ts[:16] if ts else ''}] {sender}: {text}")
    if suffix:
        lines.append(suffix)
    return " | ".join(lines)


def _format_naruto_batch(events: list[dict]) -> str:
    """Naruto-specific multi-source batch formatting."""
    tg_events       = [e for e in events if e.get("source") == "telegram"]
    konoha_events   = [e for e in events if e.get("source") == "konoha"]
    reaction_events = [e for e in events if e.get("source") == "reaction"]

    # Deduplicate: Konoha TG-bridge echoes look like "[TG Sender] text"
    # If we already have the TG event directly, skip its Konoha echo to avoid duplicate replies
    tg_texts = {(ev.get("data", ev).get("text") or "").strip() for ev in tg_events}
    konoha_deduped = []
    for ev in konoha_events:
        d = ev.get("data", ev)
        konoha_text = (d.get("text") or "").strip()
        sender = d.get("from", "")
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
        lines.append("\nОбработай и ответь через naruto-tg-send.py.")

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


def _format_sasuke_batch(events: list[dict]) -> str:
    """Sasuke-specific multi-source batch formatting."""
    tg_events       = [e for e in events if e.get("source") == "telegram"]
    konoha_events   = [e for e in events if e.get("source") == "konoha"]
    reaction_events = [e for e in events if e.get("source") == "reaction"]

    lines = []

    if tg_events:
        lines.append("Новые сообщения в Telegram:")
        for ev in tg_events:
            d = ev.get("data", ev)
            sender = (d.get("sender_name") or d.get("sender_username")
                      or d.get("user_name") or d.get("user", "?"))
            text = d.get("text", "")
            ts = (d.get("ts") or d.get("timestamp", ""))[:16]
            chat_id = d.get("chat_id", "")
            chat_title = d.get("chat_title", "")
            is_group = d.get("is_group", "0")
            msg_id = d.get("msg_id", "")
            sender_id = d.get("sender_id", "")
            meta = f"chat_id={chat_id}"
            if chat_title:
                meta += f" [{chat_title}]"
            if is_group in ("1", 1, True):
                meta += " [group]"
            if sender_id:
                meta += f" sender_id={sender_id}"
            if msg_id:
                meta += f" msg_id={msg_id}"
            attachment_path = d.get("attachment_path", "")
            attachment_kind = d.get("attachment_kind", "")
            lines.append(f"\n[{ts}] {sender} ({meta}): {text}")
            if attachment_path:
                lines.append(f"  [Вложение: {attachment_kind} — {attachment_path}]")
        lines.append("\nОбработай и при необходимости ответь через tg-send-user.py.")

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


# ── Freeze alert ──────────────────────────────────────────────────────────────

async def send_freeze_alert(session: str, waited: float, n_msgs: int) -> None:
    """Alert Kiba when agent has been unresponsive past idle_timeout."""
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
                if delivered is not False:
                    _health["last_delivered_at"] = asyncio.get_running_loop().time()
                    pending.clear()
                else:
                    log.warning(f"tmux_send timed out — retrying {len(pending)} msg(s) on next idle")
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


# ── Konoha SSE watcher ────────────────────────────────────────────────────────

async def konoha_sse_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """Read Konoha SSE stream via curl. Supports Last-Event-ID replay on reconnect."""
    agent_id = cfg["agent_id"]
    url = f"{KONOHA_URL}/messages/{agent_id}/stream"
    backoff = 1
    last_event_id = ""
    last_event_time = [0.0]  # mutable container for stale_checker closure
    SSE_STALE_TIMEOUT = cfg.get("sse_stale_timeout", 300)  # seconds

    while True:
        proc = None
        try:
            extra_headers: list[str] = []
            if last_event_id:
                extra_headers = ["-H", f"Last-Event-ID: {last_event_id}"]
                log.info(f"SSE reconnecting with Last-Event-ID={last_event_id} to {url}")
            else:
                log.info(f"SSE connecting via curl to {url}")
            env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "-N",
                "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                *extra_headers,
                url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
            )

            backoff = 1
            buf = b""
            last_event_time[0] = asyncio.get_running_loop().time()

            async def stale_checker(p: asyncio.subprocess.Process) -> None:
                while p.returncode is None:
                    await asyncio.sleep(60)
                    elapsed = asyncio.get_running_loop().time() - last_event_time[0]
                    if elapsed > SSE_STALE_TIMEOUT and p.returncode is None:
                        log.warning(f"SSE stale: no event in {int(elapsed)}s — forcing reconnect")
                        p.kill()
                        return

            stale_task = asyncio.create_task(stale_checker(proc))

            try:
                async for chunk in proc.stdout:  # type: ignore
                    buf += chunk
                    while b"\n" in buf:
                        raw_line, buf = buf.split(b"\n", 1)
                        line = raw_line.decode("utf-8", errors="replace").strip()
                        if line.startswith("id:"):
                            last_event_id = line[3:].strip()
                            last_event_time[0] = asyncio.get_running_loop().time()
                            continue
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
                            last_event_time[0] = asyncio.get_running_loop().time()
                            _health["last_received_at"] = last_event_time[0]
                            await raw_queue.put({"source": "konoha", "data": data})
                        except json.JSONDecodeError:
                            pass
            finally:
                stale_task.cancel()

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


# ── Telegram file watcher ─────────────────────────────────────────────────────

async def telegram_queue_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """
    Tail message-queue.jsonl and emit new messages.
    Tracks last seen message_id to avoid replaying old messages on restart.
    Requires cfg["telegram_file"].
    """
    agent_id = cfg["agent_id"]
    queue_path = Path(os.path.expanduser(cfg["telegram_file"]))
    last_id_file = Path(f"/tmp/watchdog-{agent_id}-last-tg-id")

    # Read last known message_id
    last_id = 0
    if last_id_file.exists():
        try:
            last_id = int(last_id_file.read_text().strip())
        except Exception:
            pass

    # On first run, seed last_id from the current end of the file (don't replay history)
    if last_id == 0 and queue_path.exists():
        try:
            lines = queue_path.read_text().strip().splitlines()
            if lines:
                last_line = json.loads(lines[-1])
                last_id = int(last_line.get("message_id", 0))
                last_id_file.write_text(str(last_id))
                log.info(f"Seeded last Telegram message_id={last_id}")
        except Exception as e:
            log.warning(f"Could not seed last_id: {e}")

    log.info(f"Watching {queue_path}, last_id={last_id}")

    backoff = 1
    while True:
        try:
            if not queue_path.exists():
                await asyncio.sleep(5)
                continue

            # Read all lines, find new ones
            lines = queue_path.read_text().strip().splitlines()
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


# ── Telegram reactions file watcher ──────────────────────────────────────────

_SEEN_REACTIONS_MAX = 500  # cap to prevent unbounded growth


def _load_seen_reactions(path: Path) -> set:
    """Load persisted set of seen reaction signatures."""
    if path.exists():
        try:
            return set(tuple(x) for x in json.loads(path.read_text()))
        except Exception:
            pass
    return set()


def _save_seen_reactions(path: Path, seen: set) -> None:
    try:
        path.write_text(json.dumps(list(seen)))
    except Exception as e:
        log.warning(f"Could not persist seen reactions: {e}")


async def reaction_queue_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """Watch reaction-queue.jsonl and deliver new reactions.

    Deduplicates by (message_id, new_reaction, user) so the same reaction
    is never delivered twice, even if appended to the file multiple times
    with different timestamps (#108).
    Requires cfg["reaction_file"].
    """
    agent_id = cfg["agent_id"]
    reaction_path = Path(os.path.expanduser(cfg["reaction_file"]))
    seen_file = Path(f"/tmp/watchdog-{agent_id}-seen-reactions.json")
    seen: set = _load_seen_reactions(seen_file)

    # On first run with empty seen set, seed from current file end to avoid
    # replaying historical reactions on restart.
    if not seen and reaction_path.exists():
        try:
            lines = reaction_path.read_text().strip().splitlines()
            for line in lines:
                try:
                    r = json.loads(line)
                    sig = (str(r.get("message_id", "")), r.get("new_reaction", ""), r.get("user", ""))
                    seen.add(sig)
                except Exception:
                    pass
            _save_seen_reactions(seen_file, seen)
            log.info(f"Seeded seen reactions: {len(seen)} entries")
        except Exception as e:
            log.warning(f"Could not seed seen reactions: {e}")

    while True:
        try:
            if not reaction_path.exists():
                await asyncio.sleep(5)
                continue

            lines = reaction_path.read_text().strip().splitlines()
            new_reactions = []
            for line in lines:
                try:
                    r = json.loads(line)
                    if not r.get("new_reaction"):
                        continue
                    sig = (str(r.get("message_id", "")), r.get("new_reaction", ""), r.get("user", ""))
                    if sig not in seen:
                        new_reactions.append(r)
                        seen.add(sig)
                except Exception:
                    pass

            if new_reactions:
                # Trim seen set to cap memory usage
                if len(seen) > _SEEN_REACTIONS_MAX:
                    seen = set(list(seen)[-_SEEN_REACTIONS_MAX:])
                _save_seen_reactions(seen_file, seen)
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


# ── Redis stream watcher ──────────────────────────────────────────────────────

async def telegram_redis_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """
    Read a Redis stream via consumer group.
    Requires cfg["redis_stream"] = {"stream": ..., "group": ..., "consumer": ...}
    """
    try:
        import redis.asyncio as aioredis
    except ImportError:
        log.error("redis.asyncio not installed — redis-stream source disabled")
        return

    rs_cfg   = cfg["redis_stream"]
    stream   = rs_cfg["stream"]
    group    = rs_cfg["group"]
    consumer = rs_cfg["consumer"]

    backoff = 1
    r = None

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

            # Ensure consumer group exists
            try:
                await r.xgroup_create(stream, group, id="$", mkstream=True)
                log.info(f"Created consumer group {group} on {stream}")
            except Exception as e:
                if "BUSYGROUP" not in str(e):
                    raise

            log.info(f"Listening on Redis stream {stream} (group={group}, consumer={consumer})")
            backoff = 1

            while True:
                # Block up to 5s waiting for new messages
                results = await r.xreadgroup(
                    group, consumer,
                    {stream: ">"},
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
                            # bus.py does NOT write action_hint — treat missing as "respond"
                            # Only drop messages explicitly marked action_hint=ignore (#53)
                            action = fields.get("action_hint", "respond")
                            if action == "ignore":
                                await r.xack(stream, group, msg_id)
                                continue
                            log.info(f"TG Redis msg from {user}: {text[:60]}")
                            _health["last_received_at"] = asyncio.get_running_loop().time()
                            await raw_queue.put({"source": "telegram", "data": fields})
                            await r.xack(stream, group, msg_id)
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


async def redis_reactions_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """Read a Redis reactions stream via consumer group.
    Requires cfg["reaction_stream"] = {"stream": ..., "group": ..., "consumer": ...}
    """
    try:
        import redis.asyncio as aioredis
    except ImportError:
        log.error("redis.asyncio not installed — redis-reactions source disabled")
        return

    rs_cfg   = cfg["reaction_stream"]
    stream   = rs_cfg["stream"]
    group    = rs_cfg["group"]
    consumer = rs_cfg["consumer"]

    backoff = 1
    r = None

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

            try:
                await r.xgroup_create(stream, group, id="$", mkstream=True)
                log.info(f"Created consumer group {group} on {stream}")
            except Exception as e:
                if "BUSYGROUP" not in str(e):
                    raise

            log.info(f"Listening on Redis stream {stream} (group={group}, consumer={consumer})")
            backoff = 1

            while True:
                results = await r.xreadgroup(
                    group, consumer,
                    {stream: ">"},
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
                            _health["last_received_at"] = asyncio.get_running_loop().time()
                            await raw_queue.put({"source": "reaction", "data": fields})
                            await r.xack(stream, group, msg_id)
                        except Exception as e:
                            log.error(f"Error processing reaction {msg_id}: {e}")

        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            log.warning(f"Reaction Redis watcher error: {e!r}, retrying in {backoff}s")
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ── GitHub Issues scanner ─────────────────────────────────────────────────────

async def github_issues_scanner(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """Poll GitHub Issues every scan_interval seconds for new open bugs.
    Requires cfg["github"] = {"repo": ..., "scan_interval": ..., "labels": [...]}
    """
    if not GH_TOKEN:
        log.warning("GH_TOKEN not set — GitHub Issues scanning disabled")
        return

    gh_cfg        = cfg["github"]
    repo          = gh_cfg["repo"]
    scan_interval = gh_cfg.get("scan_interval", 900)
    labels        = gh_cfg.get("labels", ["bug"])
    agent_id      = cfg["agent_id"]

    env = {**os.environ, "GH_TOKEN": GH_TOKEN}
    last_seen_ids: set[int] = set()

    while True:
        try:
            found_new = False
            for label in labels:
                proc = await asyncio.create_subprocess_exec(
                    "gh", "issue", "list",
                    "--repo", repo,
                    "--state", "open",
                    "--label", label,
                    "--json", "number,title,labels,createdAt",
                    "--limit", "20",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=env,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
                issues = json.loads(stdout) if stdout else []

                new_issues = [i for i in issues if i["number"] not in last_seen_ids]
                if new_issues:
                    found_new = True
                    for issue in new_issues:
                        log.info(f"New GitHub issue #{issue['number']}: {issue['title']}")
                        await raw_queue.put({
                            "source": "github",
                            "data": {
                                "from": "github",
                                "text": f"{agent_id}:fix issue={issue['number']} title={issue['title']}",
                                "timestamp": issue.get("createdAt", ""),
                            }
                        })
                        last_seen_ids.add(issue["number"])

            if not found_new:
                # Send periodic scan trigger so agent checks all open issues
                await raw_queue.put({
                    "source": "github",
                    "data": {
                        "from": "github",
                        "text": f"{agent_id}:scan",
                        "timestamp": "",
                    }
                })

        except Exception as e:
            log.warning(f"GitHub scan error: {e!r}")

        await asyncio.sleep(scan_interval)


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
    """Send heartbeat while the managed tmux session is alive.

    Skips heartbeat and broadcasts SESSION_OFFLINE when the session is inactive.
    Broadcasts SESSION_ONLINE when the session comes back up.
    """
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
    stuck_timeout = idle_timeout + 120  # must be > idle_timeout + buffer (#54, #148)
    await asyncio.sleep(30)  # grace period on startup
    while True:
        await asyncio.sleep(30)
        now = asyncio.get_running_loop().time()
        last_rx = _health["last_received_at"]
        last_tx = _health["last_delivered_at"]
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

    # Validate required fields
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

    # Build coroutine list based on configured sources
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
