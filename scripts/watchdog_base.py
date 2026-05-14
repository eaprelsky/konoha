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

from watchdog_tmux import (
    is_session_alive,
    tmux_pane_capture,
    tmux_pane_content,
    is_agent_idle,
    tmux_run,
    tmux_send,
)
from watchdog_format import is_session_noise, sanitize_message_text

# ── Config — set these in each agent script after import ─────────────────────
KONOHA_URL      = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN    = os.environ.get("KONOHA_TOKEN", "")
AGENT_ID        = ""
TMUX_SESSION    = ""

DEBOUNCE_WINDOW  = 2.0
IDLE_POLL_SEC    = 2.0
IDLE_TIMEOUT_SEC = 600
SSE_MAX_BACKOFF  = 60
SSE_MAX_REPLAY_AGE = 600  # seconds — clear Last-Event-ID if older, to avoid massive replays (#521)

# On-demand agent wake (0 = agent is always running, no wake needed)
WAKE_TIMEOUT_SEC = 0

# Circuit breaker — discard new alerts while agent is frozen (0 = disabled)
CIRCUIT_BREAKER_DURATION = 0  # seconds circuit stays open after freeze event

# Who receives freeze alerts (empty string → "kiba"; override for Kiba's own watchdog)
FREEZE_ALERT_TARGET = ""

# ── Desync detection and auto-recovery (#505) ──────────────────────────────────
DESYNC_RECOVERY_ENABLED = True   # enable auto-restart + redispatch on stuck agent
TASK_ACK_TIMEOUT_SEC    = 120    # seconds to wait for agent progress after dispatch
DESYNC_MAX_RETRIES      = 1      # max recovery attempts before giving up (per batch)
DESYNC_RECOVERY_GRACE_SEC = 30   # startup grace after successful recovery; does not consume waited budget

KONOHA_TEXT_LIMIT = 3500  # chars; tmux send-keys has ~4095 byte TTY buffer limit (#299)

# format_batch customisation — override per agent
BATCH_HEADER    = "Новые задания из Коноха:"
BATCH_FOOTER    = "Выполни задание согласно AGENTS.md. Результат сообщи в Коноха."
BATCH_SEPARATOR = "\n"

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

def try_wake_agent() -> bool:
    """Start the managed agent via Konoha lifecycle API.
    Returns True if the start request succeeded. Only used when WAKE_TIMEOUT_SEC > 0."""
    try:
        env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
        result = subprocess.run(
            [
                "curl", "-sf", "-X", "POST",
                "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                f"{KONOHA_URL}/agents/{AGENT_ID}/start",
            ],
            capture_output=True, timeout=30, env=env,
        )
        if result.returncode == 0:
            log.info(f"on-demand wake: started managed agent {AGENT_ID} via lifecycle API")
            return True
        log.warning(f"failed to wake managed agent {AGENT_ID}: {result.stderr.decode(errors='replace')[:200]}")
        return False
    except Exception as e:
        log.warning(f"failed to wake managed agent {AGENT_ID}: {e}")
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


# ── Message formatting ────────────────────────────────────────────────────────

def format_batch(events: list[dict]) -> str:
    """Default batch formatter — override per agent by monkey-patching watchdog_base.format_batch."""
    lines = [BATCH_HEADER]
    for ev in events:
        d = ev.get("data", ev)
        sender = d.get("from", "?")
        text   = d.get("text", "")
        ts     = d.get("timestamp", "")
        # Sanitize text to fix literal \n and \! artifacts (#505)
        text = sanitize_message_text(text)
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
        grace_deadline = 0.0
        while True:
            if is_agent_idle(TMUX_SESSION):
                _desync_retry_count = 0  # agent is responsive — reset recovery budget (#544)
                break
            now = time.monotonic()
            if grace_deadline > now:
                await asyncio.sleep(min(IDLE_POLL_SEC, max(0.2, grace_deadline - now)))
                continue
            if grace_deadline > 0.0:
                log.info(f"Startup grace elapsed for {TMUX_SESSION} — resuming desync timer")
                grace_deadline = 0.0
                waited = 0.0
            # On-demand wake: start the agent service if session doesn't exist
            if WAKE_TIMEOUT_SEC > 0 and not is_session_alive(TMUX_SESSION) and not wake_attempted:
                wake_attempted = True
                if try_wake_agent():
                    grace_deadline = max(grace_deadline, time.monotonic() + WAKE_TIMEOUT_SEC)
                    log.info(f"Waiting for {TMUX_SESSION} session after wake (max {WAKE_TIMEOUT_SEC}s)")
                    await asyncio.sleep(IDLE_POLL_SEC)
                    continue
            if waited >= IDLE_TIMEOUT_SEC:
                log.warning(f"Agent {TMUX_SESSION} busy >{waited:.0f}s — attempting desync recovery (#505)")
                await _send_desync_audit("agent unresponsive", f"waited={waited:.0f}s msgs={len(pending)}")
                recovered = await try_desync_recovery()
                if recovered:
                    # Recovery starts a fresh session; stale timeout budget must not carry over.
                    waited = 0.0
                    wake_attempted = False
                    grace_deadline = max(grace_deadline, time.monotonic() + DESYNC_RECOVERY_GRACE_SEC)
                    log.info(f"Desync recovery succeeded — retrying delivery of {len(pending)} msg(s)")
                    continue
                log.warning(f"Desync recovery failed — dropping {len(pending)} msgs")
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
                prompt = sanitize_message_text(prompt)
                delivered = await tmux_send(TMUX_SESSION, prompt)
                if delivered is True:
                    _desync_retry_count = 0  # delivery succeeded — reset recovery budget (#544)
                    pending.clear()
                elif delivered is False:
                    # Text sent to buffer but confirmation timed out.
                    # Clearing is safe: text is in agent's input buffer.
                    log.warning(f"tmux_send unconfirmed — clearing {len(pending)} msg(s)")
                    pending.clear()
                else:
                    # delivered is None — text never reached buffer (session dead / send-keys failed)
                    log.warning(f"tmux_send failed before buffer — retrying {len(pending)} msg(s) on next idle")
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
    last_event_id_time = 0.0  # monotonic timestamp when last_event_id was set (#521)
    last_event_time = [0.0]  # mutable container for stale_checker closure
    SSE_STALE_TIMEOUT = 300  # seconds — force reconnect if no event received
    SSE_DEDUP_MAX_SIZE = 5000  # max seen IDs before trimming (#801)
    _seen_ids: dict[str, None] = {}  # insertion-ordered dict; trim evicts oldest first

    while True:
        proc = None
        try:
            extra_headers: list[str] = []
            if last_event_id:
                # Guard against stale Last-Event-ID causing massive replay (#521)
                id_age = time.monotonic() - last_event_id_time if last_event_id_time else float("inf")
                if id_age > SSE_MAX_REPLAY_AGE:
                    log.warning(f"SSE Last-Event-ID is {int(id_age)}s old (max {SSE_MAX_REPLAY_AGE}s) — clearing to avoid massive replay (#521)")
                    last_event_id = ""
                else:
                    extra_headers = ["-H", f"Last-Event-ID: {last_event_id}"]
                    log.info(f"SSE reconnecting with Last-Event-ID={last_event_id} (age={int(id_age)}s) to {url}")
            if not last_event_id:
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
                            last_event_id_time = time.monotonic()
                            last_event_time[0] = asyncio.get_running_loop().time()
                            continue
                        if not line.startswith("data:"):
                            continue
                        last_event_time[0] = asyncio.get_running_loop().time()  # Reset on ANY data event, including pings (#521)
                        payload = line[5:].strip()
                        if not payload:
                            continue
                        try:
                            data = json.loads(payload)
                            # Dedup by Konoha message ID — prevents duplicate delivery
                            # on SSE reconnect replay (#801)
                            msg_id = data.get("id", "")
                            if msg_id and msg_id in _seen_ids:
                                log.debug(f"SSE dedup: skipping duplicate message {msg_id}")
                                continue
                            log.info(f"SSE event from {data.get('from','?')}: {data.get('text','')[:60]}")
                            if is_session_noise(data):
                                log.debug(f"Skipping SESSION noise: {data.get('text','')[:50]}")
                                continue
                            if msg_id:
                                _seen_ids[msg_id] = None
                                if len(_seen_ids) > SSE_DEDUP_MAX_SIZE:
                                    # Evict oldest entries — dict preserves insertion order (Python 3.7+)
                                    excess = len(_seen_ids) - SSE_DEDUP_MAX_SIZE // 2
                                    for _ in range(excess):
                                        _seen_ids.pop(next(iter(_seen_ids)))
                            data["_sse_id"] = last_event_id
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

    Managed agents no longer map 1:1 to legacy agent-{agent}.service units, so
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


# ── Desync detection and auto-recovery (#505) ─────────────────────────────────

_desync_retry_count: int = 0  # track recovery attempts per batch


def _agent_workdir() -> str:
    return os.environ.get("AGENT_WORKDIR", f"/opt/shared/agent-workdirs/{AGENT_ID}")


def _dirty_workdir_report() -> str:
    """Return git dirty-state evidence for the agent workdir, or an empty string."""
    workdir = _agent_workdir()
    if not os.path.isdir(workdir):
        return ""
    try:
        inside = subprocess.run(
            ["git", "-C", workdir, "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            return ""
        status = subprocess.run(
            ["git", "-C", workdir, "status", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception as e:
        return f"workdir={workdir} dirty_check_error={e!r}"
    if status.returncode != 0:
        return f"workdir={workdir} dirty_check_failed={status.stderr[:300]}"
    dirty = status.stdout.strip()
    if not dirty:
        return ""
    lines = " | ".join(dirty.splitlines()[:12])
    return f"workdir={workdir} dirty={lines}"


async def _restart_blocked_by_dirty_workdir() -> bool:
    report = _dirty_workdir_report()
    if not report:
        return False
    log.warning("Desync recovery blocked: dirty agent workdir: %s", report)
    await _send_desync_audit("restart blocked: dirty agent workdir", report)
    return True


async def _send_desync_audit(reason: str, detail: str = "") -> None:
    """Log a desync event to Konoha bus for observability."""
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    text = f"watchdog:{AGENT_ID} desync detected: {reason}"
    if detail:
        text += f" — {detail}"
    payload = json.dumps({
        "from": f"watchdog-{AGENT_ID}",
        "to": "all",
        "type": "event",
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
        log.warning(f"Desync audit sent: {text}")
    except Exception as e:
        log.error(f"Failed to send desync audit: {e}")


async def try_desync_recovery() -> bool:
    """Attempt to recover from desync by restarting the agent via Konoha lifecycle API.
    Returns True if restart request succeeded."""
    global _desync_retry_count

    if not DESYNC_RECOVERY_ENABLED:
        log.info("Desync recovery disabled — skipping")
        return False

    if _desync_retry_count >= DESYNC_MAX_RETRIES:
        log.warning(f"Desync recovery: max retries ({DESYNC_MAX_RETRIES}) reached — not retrying")
        return False

    if await _restart_blocked_by_dirty_workdir():
        return False

    _desync_retry_count += 1
    await _send_desync_audit("restarting agent", f"attempt {_desync_retry_count}/{DESYNC_MAX_RETRIES}")

    try:
        env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
        # Use lifecycle API to restart the managed agent
        result = await asyncio.create_subprocess_exec(
            "curl", "-sf", "-X", "POST",
            "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
            f"{KONOHA_URL}/agents/{AGENT_ID}/restart",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(result.communicate(), timeout=60)
        if result.returncode == 0:
            log.info(f"Desync recovery: agent {AGENT_ID} restart initiated via lifecycle API")
            # Wait for agent to come back up
            for _ in range(30):
                await asyncio.sleep(5)
                if is_session_alive(TMUX_SESSION) and is_agent_idle(TMUX_SESSION):
                    log.info(f"Desync recovery: agent {AGENT_ID} is idle after restart")
                    _desync_retry_count = 0  # reset on success
                    return True
            log.warning(f"Desync recovery: agent {AGENT_ID} not idle after 150s")
            return True  # restart succeeded even if not idle yet
        else:
            err = stderr.decode(errors="replace")[:200]
            log.error(f"Desync recovery: restart failed: {err}")
            return False
    except Exception as e:
        log.error(f"Desync recovery error: {e}")
        return False


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
