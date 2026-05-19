#!/usr/bin/env python3
"""
Акамару — автономный агент мониторинга для Кибы.
Проверяет здоровье системы каждые 60 секунд.
При обнаружении проблем отправляет алерты в Коноха → watchdog будит Кибу.

Сервисы под наблюдением:
- systemd: agent-*.service + watchdog-*.service
- tmux сессии агентов
- Redis ping
- Коноха HTTP API
- Диск / память
- Heartbeat агентов в Конохе
"""

import asyncio
import json
import logging
import os
import subprocess
import time
from datetime import datetime, timezone

# ── Config ──────────────────────────────────────────────────────────────────
KONOHA_URL   = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
AUTO_REMEDIATE = os.environ.get("AKAMARU_AUTO_REMEDIATE", "1") == "1"

CHECK_INTERVAL  = 60   # seconds between full checks
HEARTBEAT_ALERT = 600  # seconds (10 min) without heartbeat → alert
DISK_WARN_PCT   = 85
DISK_CRIT_PCT   = 90

WATCHED_SERVICES = [
    "konoha.service",
    "telegram-bot.service",
    "telegram-bus.service",
    "telegram-context-packer.service",
    "telegram-vision-packer.service",
    "agent-watchdog-lifecycle.service",
    "agent-watchdog-naruto.service",
    "agent-watchdog-sasuke.service",
    "agent-kiba.service",
    "agent-watchdog-kiba.service",
    "agent-kakashi.service",
    "agent-watchdog-kakashi.service",
    "agent-watchdog-shikadai.service",
]

SAFE_RESTART_SERVICES = {
    "telegram-bot.service",
    "telegram-bus.service",
    "telegram-context-packer.service",
    "telegram-vision-packer.service",
}

WATCHED_SESSIONS = [
    "naruto", "sasuke", "mirai", "jiraiya", "shino", "hinata",
    "kiba", "ibiki", "ino", "inojin", "guy", "kakashi",
    "shikadai",
]
WATCHED_AGENTS   = [
    "naruto", "sasuke", "mirai", "jiraiya", "shino", "hinata",
    "kiba", "ibiki", "ino", "inojin", "guy", "kakashi",
    "shikadai",
]

# On-demand agents: stop after mission complete — inactive state is expected, not a failure.
# Do NOT alert when their sessions are missing. Still alert on failed watchdogs.
ON_DEMAND_AGENTS = {"mirai", "jiraiya", "shino", "hinata", "ibiki", "ino", "inojin", "guy", "kakashi", "shikadai"}

# For each agent: watchdog service that MUST be running when the tmux session is alive (#98)
AGENT_WATCHDOGS = {
    "naruto":    "agent-watchdog-naruto.service",
    "sasuke":    "agent-watchdog-sasuke.service",
    "kakashi":   "agent-watchdog-kakashi.service",
    "shikadai":  "agent-watchdog-shikadai.service",
    "kiba":      "agent-watchdog-kiba.service",
    "jiraiya":   "agent-watchdog-lifecycle.service",
    "mirai":     "agent-watchdog-lifecycle.service",
    "shino":     "agent-watchdog-lifecycle.service",
    "hinata":    "agent-watchdog-lifecycle.service",
    "ibiki":     "agent-watchdog-lifecycle.service",
    "ino":       "agent-watchdog-lifecycle.service",
    "inojin":    "agent-watchdog-lifecycle.service",
    "guy":       "agent-watchdog-lifecycle.service",
}

PAUSED_FILE = os.getenv("AKAMARU_PAUSED_FILE", "/opt/shared/kiba/paused-services.txt")
OFFLINE_AGENTS_FILE = "/opt/shared/kiba/offline-agents.txt"
LIFECYCLE_POLL_INTERVAL = 10  # seconds between lifecycle message polls
LIFECYCLE_API_POLL_INTERVAL = 120  # seconds between /agents API lifecycle status checks (#523)

# In-memory suppression list for agents that announced going offline.
# Backed by OFFLINE_AGENTS_FILE for persistence across restarts.
_offline_agents: set[str] = set()


def load_paused() -> set[str]:
    """Load paused service/session names from file. Returns empty set on error."""
    try:
        with open(PAUSED_FILE) as f:
            return {line.strip() for line in f if line.strip()}
    except FileNotFoundError:
        return set()
    except Exception as e:
        log.warning(f"Error reading paused-services: {e}")
        return set()


def load_offline_agents() -> set[str]:
    """Load agents that announced going offline. Returns empty set on error."""
    try:
        with open(OFFLINE_AGENTS_FILE) as f:
            return {line.strip() for line in f if line.strip()}
    except FileNotFoundError:
        return set()
    except Exception as e:
        log.warning(f"Error reading offline-agents: {e}")
        return set()


def save_offline_agents(agents: set[str]) -> None:
    """Persist offline agents list to file."""
    try:
        os.makedirs(os.path.dirname(OFFLINE_AGENTS_FILE), exist_ok=True)
        with open(OFFLINE_AGENTS_FILE, "w") as f:
            for agent in sorted(agents):
                f.write(agent + "\n")
    except Exception as e:
        log.warning(f"Error saving offline-agents: {e}")


import re as _re

def _extract_agent_from_lifecycle(text: str, sender: str) -> str | None:
    """Extract agent name from a lifecycle message text or sender."""
    # SESSION_OFFLINE:agentname or SESSION_ONLINE:agentname
    m = _re.search(r"SESSION_(?:OFFLINE|ONLINE):(\w+)", text, _re.IGNORECASE)
    if m:
        return m.group(1).lower()
    # "agentname going offline"
    m = _re.search(r"(\w+)\s+going\s+offline", text, _re.IGNORECASE)
    if m:
        candidate = m.group(1).lower()
        if candidate in WATCHED_AGENTS:
            return candidate
    # fall back to sender field
    if sender and sender.lower() in WATCHED_AGENTS:
        return sender.lower()
    return None


def _is_online_event(text: str) -> bool:
    """Return True if the message signals an agent coming online."""
    lo = text.lower()
    return (
        "session_online:" in lo or
        "lifecycle=online" in lo or
        "going online" in lo
    )


def _is_offline_event(text: str) -> bool:
    """Return True if the message signals an agent going offline."""
    lo = text.lower()
    return (
        "going offline" in lo or
        "session_offline:" in lo or
        "session end" in lo
    )


async def watch_lifecycle() -> None:
    """Poll /messages/akamaru for lifecycle events and maintain offline suppression list.

    Uses a dedicated consumer group 'lifecycle' so messages are not consumed
    from the main watchdog consumer.  Runs as a background asyncio task.

    Also periodically fetches /agents API to detect lifecycle.status=stopped agents,
    suppressing false-positive alerts for intentionally stopped on-demand agents (#523).
    """
    global _offline_agents
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    last_api_poll = 0.0

    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "--max-time", "5",
                "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                f"{KONOHA_URL}/messages/akamaru?count=20&consumer=lifecycle",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode == 0 and stdout:
                try:
                    messages = json.loads(stdout)
                    if not isinstance(messages, list):
                        messages = messages.get("messages", [])
                    changed = False
                    for msg in messages:
                        text   = msg.get("text", "")
                        sender = msg.get("from", "")
                        if _is_offline_event(text):
                            agent = _extract_agent_from_lifecycle(text, sender)
                            if agent and agent in ON_DEMAND_AGENTS and agent not in _offline_agents:
                                _offline_agents.add(agent)
                                log.info(f"Lifecycle: {agent} going offline — added to suppression")
                                changed = True
                            elif agent and agent not in ON_DEMAND_AGENTS:
                                log.info(f"Lifecycle: {agent} offline event ignored for suppression (persistent agent)")
                        elif _is_online_event(text):
                            agent = _extract_agent_from_lifecycle(text, sender)
                            if agent and agent in _offline_agents:
                                _offline_agents.discard(agent)
                                log.info(f"Lifecycle: {agent} back online — removed from suppression")
                                changed = True
                    if changed:
                        save_offline_agents(_offline_agents)
                except json.JSONDecodeError:
                    pass
        except asyncio.TimeoutError:
            pass
        except Exception as e:
            log.warning(f"watch_lifecycle error: {e}")

        # Periodically sync lifecycle.status from /agents API (#523)
        # Only on-demand agents with lifecycle.status=stopped are intentionally offline.
        now = time.monotonic()
        if now - last_api_poll >= LIFECYCLE_API_POLL_INTERVAL:
            last_api_poll = now
            try:
                proc = await asyncio.create_subprocess_exec(
                    "curl", "-s", "--max-time", "10",
                    "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                    f"{KONOHA_URL}/agents",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=env,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
                if proc.returncode == 0 and stdout:
                    agents_data = json.loads(stdout)
                    agents = agents_data if isinstance(agents_data, list) else agents_data.get("agents", [])
                    stopped_agents = set()
                    running_agents = set()
                    for agent in agents:
                        aid = agent.get("id", "")
                        if not aid or aid not in WATCHED_AGENTS:
                            continue
                        lc = agent.get("lifecycle", {})
                        if lc.get("status") == "stopped" and aid in ON_DEMAND_AGENTS:
                            stopped_agents.add(aid)
                        elif lc.get("status") == "running" or aid not in ON_DEMAND_AGENTS:
                            running_agents.add(aid)
                    # Add stopped agents to suppression
                    changed = False
                    for aid in stopped_agents:
                        if aid not in _offline_agents:
                            _offline_agents.add(aid)
                            log.info(f"Lifecycle API: {aid} is stopped — added to suppression (#523)")
                            changed = True
                    # Remove running agents from suppression (unless they sent SESSION_OFFLINE)
                    for aid in running_agents:
                        if aid in _offline_agents:
                            _offline_agents.discard(aid)
                            log.info(f"Lifecycle API: {aid} is running — removed from suppression (#523)")
                            changed = True
                    if changed:
                        save_offline_agents(_offline_agents)
            except Exception as e:
                log.debug(f"Lifecycle API poll error: {e}")

        await asyncio.sleep(LIFECYCLE_POLL_INTERVAL)


COMPACTING_TIMEOUT = 600   # 10 min non-idle with compacting text → alert (#39)
STUCK_TIMEOUT      = 900   # 15 min non-idle without any Claude activity → alert

# Strings that indicate Claude Code hit the token/context limit (#111)
TOKEN_EXHAUSTION_PATTERNS = [
    "context window is full",
    "maximum context length",
    "context window has been exceeded",
    "tokens remaining: 0",
    "You've reached the context",
    "context limit",
]

ACTIVE_WORK_MARKERS = ("◦ Working", "• Working", "esc to interrupt")
CODEX_QUEUE_HINT = "tab to queue message"
CODEX_QUEUED_MESSAGES_HINT = "messages to be submitted after next tool call"

# Per-session idle tracking: {session: last_seen_idle_monotonic}
_last_idle: dict[str, float] = {}

# Per-session PID tracking: {session: (pid, first_seen_monotonic)}
# Used to suppress false stuck alerts for freshly started agent processes.
_fresh_pids: dict[str, tuple[int, float]] = {}
FRESH_PID_GRACE_SEC = 600  # 10 min grace after PID change before stuck alerts fire

LOG_FILE = "/tmp/akamaru.log"

class _FlushFileHandler(logging.FileHandler):
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

# Track previously alerted problems to avoid spam
_alerted: dict[str, float] = {}
ALERT_COOLDOWN = 300  # 5 min between repeat alerts for same issue


def should_alert(key: str) -> bool:
    now = time.time()
    last = _alerted.get(key, 0)
    if now - last >= ALERT_COOLDOWN:
        _alerted[key] = now
        return True
    return False


def is_alert_suppressed(alert: str, paused: set[str]) -> bool:
    """Return True if the alert involves a paused agent (#100).

    Defense-in-depth: individual check functions already filter by paused,
    but this catch-all at send time ensures nothing slips through if the file
    was missing when load_paused() ran.
    """
    for agent in paused:
        if (
            f"agent={agent}" in alert or
            f"session={agent}" in alert or
            f"service=agent-{agent}" in alert or
            f"service=agent-watchdog-{agent}" in alert or
            # Retired unit names may still appear in old alert payloads.
            f"service=claude-{agent}" in alert or
            f"service=claude-watchdog-{agent}" in alert
        ):
            return True
    return False


# ── Helper functions ──────────────────────────────────────────────────────────

def pane_exists(session: str) -> bool:
    """Return True if the given tmux session exists (checks named socket -L)."""
    try:
        r = subprocess.run(
            ["tmux", "-L", session, "has-session", "-t", session],
            capture_output=True, timeout=5
        )
        return r.returncode == 0
    except Exception:
        return False


def is_service_active(service: str) -> bool:
    """Return True if the given systemd service is active or activating."""
    try:
        r = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True, text=True, timeout=5
        )
        return r.stdout.strip() in ("active", "activating")
    except Exception:
        return False


def run_command(args: list[str], timeout: int = 15) -> tuple[bool, str]:
    """Run a bounded local command for deterministic remediation."""
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        output = (r.stdout + r.stderr).strip()
        return r.returncode == 0, output[:500]
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def restart_service(service: str) -> tuple[bool, str]:
    return run_command(["sudo", "-n", "systemctl", "restart", service], timeout=30)


def nudge_tmux(session: str) -> tuple[bool, str]:
    return run_command(["tmux", "-L", session, "send-keys", "-t", session, "Enter"], timeout=5)


def tmux_pane_pid(session: str) -> int | None:
    """Return tmux pane root pid for runtime detection, or None if unavailable."""
    try:
        pid = subprocess.check_output(
            ["tmux", "-L", session, "display-message", "-pt", session, "#{pane_pid}"],
            timeout=3,
        ).decode("utf-8", errors="replace").strip()
        return int(pid) if pid else None
    except Exception:
        return None


def descendant_cmdlines(root_pid: int) -> list[str]:
    """Collect process command lines under a tmux pane pid."""
    try:
        output = subprocess.check_output(
            ["ps", "-eo", "pid=,ppid=,args="],
            timeout=5,
        ).decode("utf-8", errors="replace")
    except Exception:
        return []

    children: dict[int, list[tuple[int, str]]] = {}
    for line in output.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3:
            continue
        try:
            pid = int(parts[0])
            ppid = int(parts[1])
        except ValueError:
            continue
        children.setdefault(ppid, []).append((pid, parts[2]))

    cmdlines: list[str] = []
    stack = [root_pid]
    seen: set[int] = set()
    while stack:
        parent = stack.pop()
        if parent in seen:
            continue
        seen.add(parent)
        for pid, cmdline in children.get(parent, []):
            cmdlines.append(cmdline)
            stack.append(pid)
    return cmdlines


def classify_agent_process_tree(cmdlines: list[str]) -> str:
    """Classify agent runtime from descendant process command lines."""
    runtime = "unknown"
    for cmdline in cmdlines:
        argv0 = cmdline.split(None, 1)[0].rsplit("/", 1)[-1].lower()
        lowered = cmdline.lower()
        if argv0 == "codex" or "/codex" in lowered or "codex-cli" in lowered:
            return "codex"
        if argv0 == "claude" or "/claude" in lowered or "claude code" in lowered:
            runtime = "claude"
        elif argv0 == "opencode" or "/opencode" in lowered:
            runtime = "opencode"
    return runtime


def detect_agent_runtime(session: str) -> str:
    pid = tmux_pane_pid(session)
    if pid is None:
        return "unknown"
    return classify_agent_process_tree(descendant_cmdlines(pid))


def restart_agent_session(agent: str) -> tuple[bool, str]:
    if agent not in WATCHED_AGENTS:
        return False, f"unknown agent {agent}"
    # Kill only this agent's isolated tmux socket/session. Its systemd/API manager recreates it.
    run_command(["tmux", "-L", agent, "kill-session", "-t", agent], timeout=10)
    service = f"agent-{agent}.service"
    ok, output = restart_service(service)
    if ok:
        return True, f"restarted {service}"
    return False, f"failed to restart {service}: {output}"


def extract_field(alert: str, name: str) -> str | None:
    import re
    match = re.search(rf"(?:^|\s){name}=([^\s]+)", alert)
    return match.group(1) if match else None


def remediate_alert(alert: str) -> str | None:
    """Apply narrow, deterministic fixes before waking Kiba.

    Akamaru may restart obviously dead transport/watchdog components or recycle an
    agent session with a clear terminal-level failure. It deliberately does not
    auto-approve permission prompts and does not restart konoha.service.
    """
    if not AUTO_REMEDIATE:
        return None

    service = extract_field(alert, "service")
    if service:
        if service.startswith("agent-watchdog-") or service in SAFE_RESTART_SERVICES:
            if is_service_masked(service):
                log.info(f"[suppressed] masked service {service} — skipping auto_restart")
                return None
            ok, output = restart_service(service)
            return f"auto_restart_service={service} ok={int(ok)} detail={output[:160]!r}"
        return None

    agent = extract_field(alert, "agent")
    if agent and "watchdog=dead" in alert:
        watchdog = AGENT_WATCHDOGS.get(agent)
        if watchdog:
            ok, output = restart_service(watchdog)
            return f"auto_restart_watchdog={watchdog} ok={int(ok)} detail={output[:160]!r}"

    session = extract_field(alert, "session")
    if session and "tmux=stuck_paste" in alert:
        ok, output = nudge_tmux(session)
        return f"auto_nudge_tmux={session} ok={int(ok)} detail={output[:160]!r}"

    if agent and ("token_exhausted=true" in alert or "compacting_loop" in alert):
        ok, output = restart_agent_session(agent)
        return f"auto_restart_agent={agent} ok={int(ok)} detail={output[:160]!r}"

    return None


def _has_active_work(line: str) -> bool:
    return any(marker in line for marker in ACTIVE_WORK_MARKERS)


def is_idle_prompt_state(lines: list[str]) -> bool:
    """Return True when a Claude/Codex/opencode-like terminal is ready for input."""
    normalized = [l.strip() for l in lines if l.strip()]
    last_lines = normalized[-12:]
    if any(_has_active_work(l) for l in last_lines):
        return False
    # Codex displays an input prompt while a task runs and Enter only queues a
    # follow-up in that state. Treat those panes as busy, not idle.
    if any(l.lower() == CODEX_QUEUE_HINT for l in last_lines):
        return False
    if any(l.lower().lstrip("• ").startswith(CODEX_QUEUED_MESSAGES_HINT) for l in last_lines):
        return False

    has_claude_queue = any("queued messages" in l.lower() for l in last_lines)
    has_claude_prompt = any(
        (l == "❯" or l == "❯\xa0" or l.startswith("❯ ") or l.startswith("❯\xa0"))
        and "Pasted text" not in l
        for l in last_lines
    ) and not has_claude_queue

    has_codex_startup = any("Booting MCP server" in l or "Starting MCP servers" in l for l in last_lines)
    has_codex_prompt = any(l.startswith("› ") or l == "›" for l in last_lines) and not has_codex_startup
    if has_codex_prompt:
        last_prompt_idx = max(
            (i for i, line in enumerate(normalized) if line.startswith("› ") or line == "›"),
            default=-1,
        )
        last_active_idx = max(
            (i for i, line in enumerate(normalized) if _has_active_work(line)),
            default=-1,
        )
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


# ── Check functions ───────────────────────────────────────────────────────────

def check_pid_fresh(session: str) -> bool:
    """Return True if session PID is fresh (recently started) — suppress stuck alerts.

    When a tmux session PID changes (agent restart), reset the idle tracker and
    suppress stuck/compacting alerts for FRESH_PID_GRACE_SEC. This eliminates false
    stuck alerts during agent startup (model load, AGENTS.md, registration, memory).

    Known behavior (intentional, fail-closed): on Akamaru restart, _fresh_pids is
    empty. The first threshold-crossing stuck/compacting session after Akamaru
    startup is treated as fresh and _last_idle is reset even if the session was
    genuinely stuck before Akamaru restarted. This is acceptable because:
    - Akamaru restarts are rare (deployments, config changes)
    - A genuine stuck agent will re-cross the threshold and alert on the next cycle
    - False negative (missed alert for one 60s cycle) < false positive (alert storm)

    Side effect: updates _last_idle and _fresh_pids on PID change.
    """
    pid = tmux_pane_pid(session)
    if pid is None:
        return False
    now_mono = time.monotonic()
    entry = _fresh_pids.get(session)
    if entry is not None:
        prev_pid, first_seen = entry
        if pid != prev_pid:
            _fresh_pids[session] = (pid, now_mono)
            _last_idle[session] = now_mono
            log.info(f"Fresh PID for {session}: {prev_pid} → {pid}, grace {FRESH_PID_GRACE_SEC}s")
            return True
        return now_mono - first_seen < FRESH_PID_GRACE_SEC
    _fresh_pids[session] = (pid, now_mono)
    _last_idle[session] = now_mono
    return True


def is_service_masked(service: str) -> bool:
    """Return True if the systemd service is masked (intentionally disabled).

    Checks both systemctl is-enabled and the unit file symlink to /dev/null.
    """
    try:
        r = subprocess.run(
            ["systemctl", "is-enabled", service],
            capture_output=True, text=True, timeout=5,
        )
        if r.stdout.strip() == "masked":
            return True
    except Exception:
        pass
    # Fallback: check if unit file is a symlink to /dev/null
    unit_path = f"/etc/systemd/system/{service}"
    try:
        if os.path.islink(unit_path) and os.readlink(unit_path) == "/dev/null":
            return True
    except OSError:
        pass
    return False


def check_services(paused: set[str] = frozenset()) -> list[str]:
    alerts = []
    for svc in WATCHED_SERVICES:
        short = svc.removeprefix("agent-").removeprefix("claude-").removeprefix("watchdog-").removesuffix(".service")
        if svc in paused or short in paused:
            log.debug(f"Skipping alert for paused service: {svc}")
            continue
        try:
            r = subprocess.run(
                ["systemctl", "is-active", svc],
                capture_output=True, text=True, timeout=5
            )
            status = r.stdout.strip()
            if status not in ("active", "activating"):
                # On-demand agents stop after mission — inactive is expected, not a failure
                if status in ("inactive", "deactivating") and short in ON_DEMAND_AGENTS:
                    log.debug(f"Skipping alert for on-demand agent service {svc} (inactive)")
                    continue
                # Suppress alerts for masked services — intentionally disabled (e.g. EEPC mitigation #812)
                if status in ("inactive", "deactivating") and is_service_masked(svc):
                    log.info(f"[suppressed] masked service {svc} is {status} — skipping alert")
                    continue
                key = f"service:{svc}"
                if should_alert(key):
                    alerts.append(f"kiba:alert service={svc} status={status}")
        except Exception as e:
            log.warning(f"Error checking {svc}: {e}")
    return alerts


def check_tmux_sessions(paused: set[str] = frozenset()) -> list[str]:
    alerts = []
    try:
        for session in WATCHED_SESSIONS:
            if session in paused:
                continue
            # Each agent uses a named tmux socket (-L <session>); check individually
            try:
                r = subprocess.run(
                    ["tmux", "-L", session, "has-session", "-t", session],
                    capture_output=True, timeout=5
                )
                alive = r.returncode == 0
            except Exception:
                alive = False

            if not alive:
                # On-demand agents stop after mission — missing session is expected
                if session in ON_DEMAND_AGENTS:
                    log.debug(f"Skipping tmux alert for on-demand agent: {session}")
                    continue
                key = f"tmux:{session}"
                if should_alert(key):
                    alerts.append(f"kiba:alert tmux=missing session={session}")
            else:
                # Check for stuck paste mode via pane_in_mode (not text grep — avoids false positives)
                # Double-check after 1s to filter transient mode states (e.g. brief copy-mode flicker)
                try:
                    mode = subprocess.check_output(
                        ["tmux", "-L", session, "display-message", "-pt", session, "#{pane_in_mode}"], timeout=3
                    ).decode("utf-8", errors="replace").strip()
                    if mode == "1":
                        time.sleep(1)
                        mode2 = subprocess.check_output(
                            ["tmux", "-L", session, "display-message", "-pt", session, "#{pane_in_mode}"], timeout=3
                        ).decode("utf-8", errors="replace").strip()
                        if mode2 == "1":
                            key = f"tmux:{session}:pasted"
                            if should_alert(key):
                                alerts.append(f"kiba:alert tmux=stuck_paste session={session}")
                except Exception:
                    pass

                # Detect compacting loop / stuck agent (#39)
                try:
                    pane = subprocess.check_output(
                        ["tmux", "-L", session, "capture-pane", "-pt", session], timeout=3
                    ).decode("utf-8", errors="replace")
                    lines = [l.strip() for l in pane.strip().split("\n")]
                    runtime = detect_agent_runtime(session)
                    is_idle = is_idle_prompt_state(lines)
                    now_mono = time.monotonic()
                    if is_idle:
                        _last_idle[session] = now_mono
                    else:
                        last_idle = _last_idle.get(session, now_mono)
                        non_idle_secs = now_mono - last_idle
                        is_compacting = any("ompacting" in l for l in lines[-10:])
                        if is_compacting and non_idle_secs >= COMPACTING_TIMEOUT:
                            if check_pid_fresh(session):
                                log.debug(f"Suppressing compacting alert for {session}: fresh PID")
                            else:
                                key = f"tmux:{session}:compacting"
                                if should_alert(key):
                                    mins = int(non_idle_secs // 60)
                                    alerts.append(
                                        f"kiba:alert agent={session} compacting_loop duration={mins}min"
                                    )
                        elif not is_compacting and non_idle_secs >= STUCK_TIMEOUT:
                            if check_pid_fresh(session):
                                log.debug(f"Suppressing stuck alert for {session}: fresh PID")
                            else:
                                key = f"tmux:{session}:stuck"
                                if should_alert(key):
                                    mins = int(non_idle_secs // 60)
                                    alerts.append(
                                        f"kiba:alert agent={session} runtime={runtime} stuck duration={mins}min"
                                    )

                    # Detect token/context exhaustion (#111)
                    # Only check the last 30 lines (not full scrollback) to avoid false positives
                    # when the agent has already recovered but the error text lingers in history.
                    recent_lower = "\n".join(lines[-30:]).lower()
                    if any(p.lower() in recent_lower for p in TOKEN_EXHAUSTION_PATTERNS):
                        # Suppress if agent is idle (at prompt) — likely already recovered (#523)
                        if is_idle:
                            log.debug(f"Skipping token_exhausted for {session}: agent is idle (recovered)")
                        else:
                            key = f"tmux:{session}:token_exhausted"
                            if should_alert(key):
                                alerts.append(
                                    f"kiba:alert agent={session} token_exhausted=true action=restart"
                                )

                    # Skip check when the agent is visibly doing active work (MCP calls, tool
                    # progress, etc.). False positives occur when tool output happens to contain
                    # prompt-like strings ("(Y/n)" in a document being written, for example).
                    # Spinner chars indicate MCP/tool work is running.
                    #
                    # Known limitation: if a spinner char lingers in the tmux scroll-back buffer
                    # after an MCP call completes, and a real permission_prompt appears immediately
                    # after, is_actively_working may be True and the alert will be suppressed (false
                    # negative). Risk is low — the next 60s check will catch it once the buffer scrolls.
                    ACTIVE_WORK_INDICATORS = [
                        "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",  # spinner chars
                    ]
                    is_actively_working = any(
                        any(ind in l for ind in ACTIVE_WORK_INDICATORS)
                        for l in lines[-20:]
                    )
                    is_permission_prompt = is_permission_prompt_state(lines[-15:])
                    if not is_actively_working and is_permission_prompt:
                        key = f"tmux:{session}:permission_prompt"
                        if should_alert(key):
                            alerts.append(
                                f"kiba:alert agent={session} frozen=permission_prompt action_hint=approve_or_deny"
                            )
                except Exception:
                    pass
    except Exception as e:
        log.warning(f"Error checking tmux: {e}")
    return alerts


def is_permission_prompt_state(lines: list[str]) -> bool:
    """Return True only for real Claude Code permission prompts, not idle shortcut hints."""
    status_bar_noise = ["bypass permissions", "shift+tab", "bypasspermissions"]
    prompt_lines = [l for l in lines if not any(noise in l.lower() for noise in status_bar_noise)]
    pane_text = "\n".join(prompt_lines)
    pane_text_lower = pane_text.lower()

    permission_patterns = [
        "do you want to proceed",
        "(y/n)",
    ]
    # Require UI markers from the Claude Code prompt rather than matching bare "(Y/n)"
    # anywhere in the scrollback.
    permission_ui_markers = [
        "don't ask again",
        "esc to cancel",
        "\u276f 1. yes",
    ]
    # Idle prompt "❯ ? for shortcuts" may coexist with stale "(Y/n)" scrollback and
    # "Esc to cancel", causing a false-positive frozen=permission_prompt alert. Exclude
    # that state unless an explicit permission choice UI is also visible.
    idle_shortcut_markers = [
        "? for shortcuts",
    ]
    explicit_choice_markers = [
        "\u276f 1. yes",
        "1. yes",
        "2. no",
    ]

    has_permission_pattern = any(pattern in pane_text_lower for pattern in permission_patterns)
    has_permission_ui = any(marker in pane_text_lower for marker in permission_ui_markers)
    has_explicit_choice_ui = any(marker in pane_text_lower for marker in explicit_choice_markers)
    is_idle_shortcuts_only = (
        any(marker in pane_text_lower for marker in idle_shortcut_markers)
        and not has_explicit_choice_ui
    )

    return has_permission_pattern and has_permission_ui and not is_idle_shortcuts_only


def check_orphaned_sessions(paused: set[str] = frozenset()) -> list[str]:
    """Alert when agent tmux session is alive but watchdog service is inactive (#98).

    Scenario: watchdog stopped (e.g. OOM killer, manual stop) but agent tmux was later
    restarted without the watchdog. Agent receives no Konoha messages silently.
    """
    alerts = []
    try:
        for agent in WATCHED_SESSIONS:
            if agent in paused:
                continue
            if not pane_exists(agent):
                continue  # session not running — normal for on-demand agents, skip
            # Session alive — watchdog must also be active
            watchdog_svc = AGENT_WATCHDOGS.get(agent)
            if not watchdog_svc:
                continue
            if watchdog_svc in paused:
                continue
            if not is_service_active(watchdog_svc):
                key = f"orphan:{agent}:watchdog_dead"
                if should_alert(key):
                    alerts.append(
                        f"kiba:alert agent={agent} watchdog=dead session=alive"
                    )
    except Exception as e:
        log.warning(f"Error in check_orphaned_sessions: {e}")
    return alerts


def check_redis() -> list[str]:
    try:
        r = subprocess.run(
            ["redis-cli", "ping"],
            capture_output=True, text=True, timeout=5
        )
        if r.stdout.strip() != "PONG":
            if should_alert("redis:down"):
                return ["kiba:alert redis=down"]
    except Exception as e:
        if should_alert("redis:down"):
            return [f"kiba:alert redis=down error={e}"]
    return []


def check_disk() -> list[str]:
    alerts = []
    try:
        r = subprocess.run(
            ["df", "-h", "/", "--output=pcent"],
            capture_output=True, text=True, timeout=5
        )
        lines = r.stdout.strip().split("\n")
        if len(lines) >= 2:
            pct = int(lines[1].strip().rstrip("%"))
            if pct >= DISK_CRIT_PCT:
                if should_alert("disk:critical"):
                    alerts.append(f"kiba:alert disk=critical pct={pct}")
            elif pct >= DISK_WARN_PCT:
                if should_alert("disk:warn"):
                    alerts.append(f"kiba:alert disk=warning pct={pct}")
    except Exception as e:
        log.warning(f"Error checking disk: {e}")
    return alerts


async def check_konoha(paused: set[str] = frozenset()) -> list[str]:
    """Check Konoha HTTP API and agent heartbeats."""
    alerts = []
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    try:
        # Use /health (lightweight) for liveness check — /agents returns ~30KB and can timeout (#282)
        health_proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "--max-time", "5",
            "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
            f"{KONOHA_URL}/health",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
        health_out, _ = await asyncio.wait_for(health_proc.communicate(), timeout=10)
        if health_proc.returncode != 0 or not health_out:
            if should_alert("konoha:down"):
                alerts.append("kiba:alert konoha=down")
            return alerts

        # Fetch agent list separately for heartbeat checks
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "--max-time", "10",
            "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
            f"{KONOHA_URL}/agents",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        if not stdout:
            return alerts  # Konoha is up (health passed), skip heartbeat checks this round

        try:
            agents_data = json.loads(stdout)
            agents = agents_data if isinstance(agents_data, list) else agents_data.get("agents", [])
            now = time.time()
            online_ids = set()
            for agent in agents:
                aid = agent.get("id", "")
                online_ids.add(aid)
                last_seen = agent.get("lastSeen") or agent.get("last_seen")
                if last_seen:
                    # Parse ISO timestamp
                    try:
                        ts = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
                        age = now - ts.timestamp()
                        if age > HEARTBEAT_ALERT:
                            if aid in paused:
                                log.debug(f"Skipping heartbeat alert for paused agent: {aid}")
                                continue
                            if aid in ON_DEMAND_AGENTS:
                                log.debug(f"Skipping heartbeat alert for on-demand agent: {aid}")
                                continue
                            key = f"agent:{aid}:offline"
                            if should_alert(key):
                                alerts.append(f"kiba:alert agent={aid} offline={int(age//60)}min")
                    except Exception:
                        pass
        except json.JSONDecodeError:
            pass

    except asyncio.TimeoutError:
        if should_alert("konoha:down"):
            alerts.append("kiba:alert konoha=timeout")
    except Exception as e:
        log.warning(f"Error checking Konoha: {e}")
    return alerts


# ── Alert sender ──────────────────────────────────────────────────────────────

async def send_alert(text: str) -> None:
    """Send alert to Kiba via Konoha bus."""
    payload = json.dumps({
        "from": "akamaru",
        "to": "kiba",
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
        log.info(f"Alert sent to kiba: {text}")
    except Exception as e:
        log.error(f"Failed to send alert: {e}")


# ── Main loop ─────────────────────────────────────────────────────────────────

async def main() -> None:
    if not KONOHA_TOKEN:
        raise RuntimeError("KONOHA_TOKEN env var not set")

    log.info("Akamaru starting — monitoring Konoha system health")

    # Load persisted offline suppression list from previous run
    global _offline_agents
    loaded_offline = load_offline_agents()
    _offline_agents = {agent for agent in loaded_offline if agent in ON_DEMAND_AGENTS}
    if _offline_agents != loaded_offline:
        save_offline_agents(_offline_agents)
        log.info(f"Removed persistent agents from offline suppression: {loaded_offline - _offline_agents}")
    if _offline_agents:
        log.info(f"Loaded offline suppression list: {_offline_agents}")

    # Start lifecycle watcher background task (#105)
    asyncio.create_task(watch_lifecycle())

    # Send initial healthcheck trigger after 30s startup grace
    await asyncio.sleep(30)

    check_count = 0
    while True:
        check_count += 1
        alerts: list[str] = []

        # Run sync checks in thread pool to avoid blocking
        loop = asyncio.get_running_loop()
        # Merge manual paused list with lifecycle-based offline suppression (#105)
        paused = load_paused() | _offline_agents
        svc_alerts      = await loop.run_in_executor(None, lambda: check_services(paused))
        tmux_alerts     = await loop.run_in_executor(None, lambda: check_tmux_sessions(paused))
        orphan_alerts   = await loop.run_in_executor(None, lambda: check_orphaned_sessions(paused))
        redis_alerts    = await loop.run_in_executor(None, check_redis)
        disk_alerts     = await loop.run_in_executor(None, check_disk)
        konoha_alerts   = await check_konoha(paused)

        alerts = svc_alerts + tmux_alerts + orphan_alerts + redis_alerts + disk_alerts + konoha_alerts

        # Re-read paused at send time (defense-in-depth: file may have been created
        # after the check pass, or an individual check may have missed the filter)
        paused = load_paused() | _offline_agents
        alerts = [a for a in alerts if not is_alert_suppressed(a, paused)]

        if alerts:
            log.warning(f"Found {len(alerts)} alert(s): {alerts}")
            for alert in alerts:
                remediation = remediate_alert(alert)
                if remediation:
                    log.warning(f"Remediation for {alert}: {remediation}")
                    alert = f"{alert} {remediation}"
                await send_alert(alert)
        else:
            log.debug(f"Check #{check_count}: all systems OK")

        # Every 30 checks (~30 min) send a healthcheck trigger
        if check_count % 30 == 0:
            await send_alert("kiba:healthcheck")

        await asyncio.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Akamaru stopped.")
