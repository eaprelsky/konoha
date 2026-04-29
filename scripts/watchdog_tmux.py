#!/usr/bin/env python3
"""
watchdog_tmux — tmux helpers and message delivery for Konoha watchdogs.

Extracted from watchdog.py (#573). Imported by watchdog.py and watchdog_base.py.
"""

import asyncio
import logging
import subprocess
import time

log = logging.getLogger(__name__)
ACTIVE_WORK_MARKERS = ("◦ Working", "• Working", "esc to interrupt")

# ── Idle detection ───────────────────────────────────────────────────────────

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


def _has_active_work(line: str) -> bool:
    return any(marker in line for marker in ACTIVE_WORK_MARKERS)


def _prompt_snippet(text: str) -> str:
    return " ".join(text.split())[:80]


def _has_active_work_after_prompt(content: str, text: str) -> bool:
    normalized = " ".join(content.split())
    snippet = _prompt_snippet(text)
    if snippet and snippet in normalized:
        return any(marker in normalized[normalized.rfind(snippet):] for marker in ACTIVE_WORK_MARKERS)

    lines = [l.strip() for l in content.strip().split("\n") if l.strip()]
    return any(_has_active_work(l) for l in lines[-4:])


def _has_idle_prompt(content: str) -> bool:
    lines = [l.strip() for l in content.strip().split("\n") if l.strip()]
    last_lines = lines[-12:]
    has_claude_queue = any("queued messages" in l.lower() for l in last_lines)
    has_claude_prompt = any(
        (l == "❯" or l == "❯ " or l.startswith("❯ ") or l.startswith("❯ "))
        and "Pasted text" not in l
        for l in last_lines
    ) and not has_claude_queue
    has_codex_startup = any("Booting MCP server" in l or "Starting MCP servers" in l for l in last_lines)
    has_codex_prompt = any(l.startswith("› ") for l in last_lines) and not has_codex_startup
    if has_codex_prompt:
        last_prompt_idx = max((i for i, l in enumerate(lines) if l.startswith("› ")), default=-1)
        last_active_idx = max((i for i, l in enumerate(lines) if _has_active_work(l)), default=-1)
        if last_active_idx > last_prompt_idx:
            return False
    has_cursor_ready = (
        any("→ Add a follow-up" in l for l in last_lines)
        or any("ctrl+c to stop" in l for l in last_lines)
        or any("▶︎ Auto-run everything" in l for l in last_lines)
    )
    has_opencode_idle = (
        any("ctrl+p commands" in l for l in last_lines)
        or any("tab agents" in l for l in last_lines)
    )
    return has_claude_prompt or has_codex_prompt or has_cursor_ready or has_opencode_idle


def is_agent_idle(session: str, stable_checks: int = 2) -> bool:
    """Return True if agent shows a stable ready-for-input prompt (Claude/Codex/Cursor)."""
    for _ in range(stable_checks):
        alive, content = tmux_pane_capture(session)
        if not alive or not _has_idle_prompt(content):
            return False
        if stable_checks > 1:
            time.sleep(1.0)
    return True


# ── tmux send ────────────────────────────────────────────────────────────────

async def tmux_run(*args: str, timeout: float = 10.0) -> bool:
    """Run a tmux command asynchronously. Returns True on success, False on timeout."""
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
    """Deliver a text prompt to an agent tmux session, handling idle detection,
    compacting waits, [Pasted text] dismissal, and submit retries."""
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
            if _has_active_work_after_prompt(pane, text):
                log.info("Delivery confirmed: agent left idle state after submit")
                return True
            if pane.strip() and not _has_idle_prompt(pane) and _prompt_snippet(text) not in " ".join(pane.split()):
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
