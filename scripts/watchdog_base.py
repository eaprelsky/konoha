#!/usr/bin/env python3
"""
watchdog_base — shared core for all agent watchdogs.

Usage in a per-agent watchdog script:
    import watchdog_base as _b
    _b.AGENT_ID        = "guy"
    _b.TMUX_SESSION    = "guy"
    _b.DEBOUNCE_WINDOW = 2.0
    _b.IDLE_TIMEOUT_SEC = 600
    _b.BATCH_HEADER    = "Задание для Гая:"
    # optionally override _b.format_batch()
    if __name__ == "__main__":
        asyncio.run(_b.run_watchdog())

For agents with extra watchers or loops, call run_watchdog() with kwargs:
    asyncio.run(_b.run_watchdog(
        extra_watchers=[my_watcher],   # each receives raw_queue as sole arg
        extra_loops=[my_loop()],       # already-constructed coroutines
    ))
"""
import asyncio
from datetime import datetime, timezone
import json
import logging
import os
import subprocess
import time

# ── Config — set these in each agent script after import ─────────────────────
KONOHA_URL      = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN    = os.environ.get("KONOHA_TOKEN", "")
AGENT_ID        = ""
TMUX_SESSION    = ""

DEBOUNCE_WINDOW  = 2.0
IDLE_POLL_SEC    = 2.0
IDLE_TIMEOUT_SEC = 600
SSE_MAX_BACKOFF  = 60

# On-demand agent wake (0 = agent is always running, no wake needed)
WAKE_TIMEOUT_SEC = 0

# Circuit breaker — discard new alerts while agent is frozen (0 = disabled)
CIRCUIT_BREAKER_DURATION = 0  # seconds circuit stays open after freeze event

# Who receives freeze alerts (empty string → "kiba"; override for Kiba's own watchdog)
FREEZE_ALERT_TARGET = ""

KONOHA_TEXT_LIMIT = 3500  # chars; tmux send-keys has ~4095 byte TTY buffer limit (#299)

# format_batch customisation — override per agent
BATCH_HEADER    = "Новые задания из Коноха:"
BATCH_FOOTER    = "Выполни задание согласно AGENTS.md. Результат сообщи в Коноха."
BATCH_SEPARATOR = "\n"

# SESSION_ONLINE/OFFLINE are system noise — never deliver to agent
NOISE_TEXT_PREFIXES = ("SESSION_ONLINE:", "SESSION_OFFLINE:")
NOISE_TEXT_CONTAINS = ("going offline (session end)",)


# ── Logging — call setup_logging() once AGENT_ID is set ──────────────────────

log: logging.Logger = logging.getLogger("watchdog")


class _FlushFileHandler(logging.FileHandler):
    """FileHandler that flushes after each record — prevents log buffering on restart."""
    def emit(self, record):
        super().emit(record)
        self.flush()


def setup_logging() -> None:
    log_file = f"/tmp/watchdog-{AGENT_ID}.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            _FlushFileHandler(log_file),
            logging.StreamHandler(),
        ],
        force=True,
    )


# ── On-demand agent wake ────────────────────────────────────────────────────

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


def try_wake_agent() -> bool:
    """Start claude-{AGENT_ID}.service to wake the on-demand agent.
    Returns True if start was attempted. Only used when WAKE_TIMEOUT_SEC > 0."""
    service = f"claude-{AGENT_ID}.service"
    try:
        subprocess.run(
            ["sudo", "systemctl", "start", service],
            capture_output=True, timeout=30,
        )
        log.info(f"on-demand wake: started {service}")
        return True
    except Exception as e:
        log.warning(f"failed to wake {service}: {e}")
        return False


# ── Circuit breaker ───────────────────────────────────────────────────────────

_circuit_open_until: float = 0.0  # monotonic timestamp; 0.0 = circuit closed


def circuit_is_open() -> bool:
    """Return True while circuit is open (CIRCUIT_BREAKER_DURATION > 0 and tripped)."""
    return CIRCUIT_BREAKER_DURATION > 0 and time.monotonic() < _circuit_open_until


def open_circuit(reason: str) -> None:
    """Open the circuit for CIRCUIT_BREAKER_DURATION seconds."""
    global _circuit_open_until
    _circuit_open_until = time.monotonic() + CIRCUIT_BREAKER_DURATION
    log.warning(f"Circuit opened for {CIRCUIT_BREAKER_DURATION}s: {reason}")


# ── Noise filter ─────────────────────────────────────────────────────────────

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
            ["tmux", "-L", session, "capture-pane", "-pt", session],
            timeout=3
        ).decode("utf-8", errors="replace")
    except Exception:
        return ""


def is_agent_idle(session: str, stable_checks: int = 2) -> bool:
    def has_prompt(content: str) -> bool:
        lines = [l.strip() for l in content.strip().split("\n") if l.strip()]
        last_lines = lines[-12:]
        has_claude_prompt = any(
            (l == "❯" or l == "❯\xa0" or l.startswith("❯ ") or l.startswith("❯\xa0"))
            and "Pasted text" not in l
            for l in last_lines
        )
        has_cursor_ready = (
            any("→ Add a follow-up" in l for l in last_lines)
            or any("ctrl+c to stop" in l for l in last_lines)
            or any("▶︎ Auto-run everything" in l for l in last_lines)
        )
        return has_claude_prompt or has_cursor_ready
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


async def tmux_send(session: str, text: str) -> bool:
    # Collapse newlines to spaces — multi-line text triggers Claude Code [Pasted text] dialog
    text = text.replace("\n", " ").replace("\r", " ")
    # Wait for compacting to finish before sending — avoids [Pasted text] race (#147)
    compacting_waited = 0
    while compacting_waited < 120:
        pane = tmux_pane_content(session)
        last_lines = [l.strip() for l in pane.strip().split(chr(10))[-12:] if l.strip()]
        has_claude_prompt = any(l == "❯" or l == "❯ " or l.startswith("❯ ") or l.startswith("❯ ") for l in last_lines)
        has_cursor_ready = any("→ Add a follow-up" in l for l in last_lines) or any("▶︎ Auto-run everything" in l for l in last_lines)
        # Prompt visible → session idle, not compacting.
        if has_claude_prompt or has_cursor_ready:
            break
        log.info(f"Agent {session} compacting — waiting (waited {compacting_waited}s)")
        await asyncio.sleep(2.0)
        compacting_waited += 2
    if compacting_waited >= 120:
        log.warning(f"Agent {session} still compacting after 120s — proceeding anyway")
    elif compacting_waited > 0:
        log.info(f"Compacting done after {compacting_waited}s — proceeding")
        await asyncio.sleep(1.0)  # small buffer after compacting ends

    # Capture pane content BEFORE send to detect delivery confirmation (#50)
    content_before = tmux_pane_content(session)
    ok = await tmux_run("tmux", "-L", session, "send-keys", "-t", session, text, timeout=5.0)
    if not ok:
        log.error(f"send-keys timed out for {session} — skipping delivery")
        return False
    # Wait for potential [Pasted text] dialog before sending Enter (#145 race fix)
    await asyncio.sleep(0.8)
    _pane_check = tmux_pane_content(session)
    if any("Pasted text" in _line for _line in _pane_check.strip().split("\n")[-8:]):
        log.info("Detected [Pasted text] prompt — sending Enter to dismiss (#91 #145)")
        await tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter", timeout=5.0)
        await asyncio.sleep(0.5)
    # Always send submit Enter after optional dialog dismissal (#145)
    await tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter", timeout=5.0)
    log.info(f"Sent prompt to {session} ({len(text)} chars)")
    await asyncio.sleep(1.2)  # give agent time to start processing
    for attempt in range(3):
        content_after = tmux_pane_content(session)
        if content_after != content_before:
            log.info(f"Delivery confirmed: pane content changed after send")
            break  # pane changed — agent received the message (#50)
        if not is_agent_idle(session, stable_checks=2):
            break  # agent is processing — good
        log.warning(f"Pane unchanged and agent idle (attempt {attempt+1}), resending full prompt")
        await tmux_run("tmux", "-L", session, "send-keys", "-t", session, "C-u", timeout=5.0)
        ok = await tmux_run("tmux", "-L", session, "send-keys", "-t", session, text, timeout=5.0)
        if not ok:
            log.error(f"Resend attempt {attempt+1} timed out for {session}")
            break
        await asyncio.sleep(0.3)
        await tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter", timeout=5.0)
        await asyncio.sleep(2.0)
    return True


# ── Message formatting ────────────────────────────────────────────────────────

def format_batch(events: list[dict]) -> str:
    """Default batch formatter — override per agent by monkey-patching watchdog_base.format_batch."""
    lines = [BATCH_HEADER]
    for ev in events:
        d = ev.get("data", ev)
        sender = d.get("from", "?")
        text   = d.get("text", "")
        ts     = d.get("timestamp", "")
        if len(text) > KONOHA_TEXT_LIMIT:
            log.warning(f"Konoha message from {sender} truncated: {len(text)} chars → {KONOHA_TEXT_LIMIT}")
            text = text[:KONOHA_TEXT_LIMIT] + f"... [сообщение обрезано: {len(d.get('text',''))} символов — вызови konoha_read для полного текста]"
        lines.append(f"[{ts[:16] if ts else ''}] {sender}: {text}")
    lines.append(BATCH_FOOTER)
    return BATCH_SEPARATOR.join(lines)


# ── Send loop ─────────────────────────────────────────────────────────────────

async def send_loop(batched_queue: asyncio.Queue) -> None:
    pending: list[dict] = []

    while True:
        # ── Circuit breaker: drain and discard while circuit is open ──────────
        if circuit_is_open():
            try:
                await asyncio.wait_for(batched_queue.get(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
            pending.clear()
            continue

        try:
            timeout = 1.0 if pending else None
            batch = await asyncio.wait_for(batched_queue.get(), timeout=timeout)
            pending.extend(batch)
        except asyncio.TimeoutError:
            pass

        if not pending:
            continue

        waited = 0.0
        wake_attempted = False
        while True:
            if is_agent_idle(TMUX_SESSION):
                break
            # On-demand wake: start the agent service if session doesn't exist
            if WAKE_TIMEOUT_SEC > 0 and not is_session_alive(TMUX_SESSION) and not wake_attempted:
                wake_attempted = True
                if try_wake_agent():
                    log.info(f"Waiting for {TMUX_SESSION} session after wake (max {WAKE_TIMEOUT_SEC}s)")
                    await asyncio.sleep(IDLE_POLL_SEC)
                    waited += IDLE_POLL_SEC
                    continue
            timeout_limit = max(IDLE_TIMEOUT_SEC, WAKE_TIMEOUT_SEC if wake_attempted else IDLE_TIMEOUT_SEC)
            if waited >= timeout_limit:
                log.warning(f"Agent {TMUX_SESSION} busy >{waited:.0f}s — dropping {len(pending)} msgs")
                if CIRCUIT_BREAKER_DURATION > 0:
                    open_circuit(f"agent={TMUX_SESSION} unresponsive >{waited:.0f}s")
                await send_freeze_alert(TMUX_SESSION, waited, len(pending))
                pending.clear()
                break
            await asyncio.sleep(IDLE_POLL_SEC)
            waited += IDLE_POLL_SEC

        if pending:
            try:
                prompt = format_batch(pending)
                delivered = await tmux_send(TMUX_SESSION, prompt)
                if delivered is not False:
                    pending.clear()
                else:
                    log.warning(f"tmux_send timed out — retrying {len(pending)} msg(s) on next idle")
            except Exception as e:
                log.error(f"tmux send failed: {e}")
                pending.clear()


async def send_freeze_alert(session: str, waited: float, n_msgs: int) -> None:
    """Alert the freeze-alert target when agent has been unresponsive past IDLE_TIMEOUT_SEC.
    Target defaults to 'kiba'; override FREEZE_ALERT_TARGET for Kiba's own watchdog."""
    target = FREEZE_ALERT_TARGET or "kiba"
    text = (
        f"kiba:alert agent={session} frozen timeout={int(waited)}s msgs_dropped={n_msgs}"
        if target == "kiba"
        else f"kiba:alert agent={session} frozen timeout={int(waited)}s msgs_dropped={n_msgs} circuit=open — restart may be needed"
    )
    payload = json.dumps({
        "from": f"watchdog-{session}",
        "to": target,
        "text": text,
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
        log.warning(f"Freeze alert sent to {target}: agent={session} waited={int(waited)}s")
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
    """Read Konoha SSE stream via curl. Supports Last-Event-ID replay on reconnect."""
    url = f"{KONOHA_URL}/messages/{AGENT_ID}/stream"
    backoff = 1
    last_event_id = ""
    last_event_time = [0.0]  # mutable container for stale_checker closure
    SSE_STALE_TIMEOUT = 300  # seconds — force reconnect if no event received

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


# ── Heartbeat ─────────────────────────────────────────────────────────────────

async def _send_lifecycle(text: str, env: dict) -> None:
    """Broadcast a lifecycle event (SESSION_ONLINE/OFFLINE) to all agents."""
    payload = json.dumps({
        "from": f"watchdog-{AGENT_ID}",
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


async def heartbeat_loop() -> None:
    """Send heartbeat while the managed tmux session is alive.

    Managed agents no longer map 1:1 to legacy claude-{agent}.service units, so
    liveness must follow the named tmux session used by Konoha lifecycle.
    """
    url = f"{KONOHA_URL}/agents/{AGENT_ID}/heartbeat"
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    was_active = is_session_alive(TMUX_SESSION)
    while True:
        try:
            is_active = is_session_alive(TMUX_SESSION)
        except Exception as e:
            log.warning(f"Could not check tmux session {TMUX_SESSION}: {e}")
            is_active = True

        if is_active:
            if not was_active:
                await _send_lifecycle(f"SESSION_ONLINE:{AGENT_ID}", env)
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
            log.info(f"tmux session {TMUX_SESSION} inactive — skipping heartbeat")
            if was_active:
                await _send_lifecycle(f"SESSION_OFFLINE:{AGENT_ID}", env)

        was_active = is_active
        await asyncio.sleep(300)  # every 5 min


# ── Standard entry point ──────────────────────────────────────────────────────

async def run_watchdog(
    extra_watchers: list | None = None,
    extra_loops: list | None = None,
) -> None:
    """
    Standard watchdog main loop.

    extra_watchers: list of async callables that accept raw_queue as sole arg.
                    e.g. [github_issues_scanner]  (called as fn(raw_queue))
    extra_loops:    list of already-constructed coroutines.
                    e.g. [auto_push_loop(), health_monitor()]
    """
    if not KONOHA_TOKEN:
        raise RuntimeError("KONOHA_TOKEN env var not set")

    setup_logging()
    log.info(f"Watchdog starting for agent={AGENT_ID}, session={TMUX_SESSION}")

    raw_queue: asyncio.Queue = asyncio.Queue()
    batched_queue: asyncio.Queue = asyncio.Queue()

    coros = [
        konoha_sse_watcher(raw_queue),
        debouncer(raw_queue, batched_queue),
        send_loop(batched_queue),
        heartbeat_loop(),
    ]
    if extra_watchers:
        for fn in extra_watchers:
            coros.append(fn(raw_queue))
    if extra_loops:
        coros.extend(extra_loops)

    await asyncio.gather(*coros)
