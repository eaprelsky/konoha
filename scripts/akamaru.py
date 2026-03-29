#!/usr/bin/env python3
"""
Акамару — автономный агент мониторинга для Кибы.
Проверяет здоровье системы каждые 60 секунд.
При обнаружении проблем отправляет алерты в Коноха → watchdog будит Кибу.

Сервисы под наблюдением:
- systemd: claude-*.service + watchdog-*.service
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

CHECK_INTERVAL  = 60   # seconds between full checks
HEARTBEAT_ALERT = 600  # seconds (10 min) without heartbeat → alert
DISK_WARN_PCT   = 85
DISK_CRIT_PCT   = 90

WATCHED_SERVICES = [
    "claude-naruto.service",
    "claude-sasuke.service",
    "claude-mirai.service",
    "claude-jiraiya.service",
    "claude-shino.service",
    "claude-hinata.service",
    "claude-kiba.service",
    "claude-watchdog-naruto.service",
    "claude-watchdog-sasuke.service",
    "claude-watchdog-mirai.service",
    "claude-watchdog-jiraiya.service",
    "claude-watchdog-shino.service",
    "claude-watchdog-hinata.service",
    "claude-watchdog-kiba.service",
    "claude-ibiki.service",
    "claude-watchdog-ibiki.service",
]

WATCHED_SESSIONS = ["naruto", "sasuke", "mirai", "jiraiya", "shino", "hinata", "kiba", "ibiki", "ino", "inojin"]
WATCHED_AGENTS   = ["naruto", "sasuke", "mirai", "jiraiya", "shino", "hinata", "kiba", "ibiki", "ino", "inojin"]

# For each agent: watchdog service that MUST be running when the tmux session is alive (#98)
AGENT_WATCHDOGS = {
    "naruto":  "claude-watchdog-naruto.service",
    "sasuke":  "claude-watchdog-sasuke.service",
    "mirai":   "claude-watchdog-mirai.service",
    "jiraiya": "claude-watchdog-jiraiya.service",
    "shino":   "claude-watchdog-shino.service",
    "hinata":  "claude-watchdog-hinata.service",
    "kiba":    "claude-watchdog-kiba.service",
    "ibiki":   "claude-watchdog-ibiki.service",
    "ino":     "claude-watchdog-ino.service",
    "inojin":  "claude-watchdog-inojin.service",
    "guy":     "claude-watchdog-guy.service",
    "kakashi": "claude-watchdog-kakashi.service",
}

PAUSED_FILE = "/opt/shared/kiba/paused-services.txt"


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


COMPACTING_TIMEOUT = 600   # 10 min non-idle with compacting text → alert (#39)
STUCK_TIMEOUT      = 900   # 15 min non-idle without any Claude activity → alert

# Per-session idle tracking: {session: last_seen_idle_monotonic}
_last_idle: dict[str, float] = {}

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
            f"service=claude-{agent}" in alert or
            f"service=claude-watchdog-{agent}" in alert
        ):
            return True
    return False


# ── Check functions ───────────────────────────────────────────────────────────

def check_services(paused: set[str] = frozenset()) -> list[str]:
    alerts = []
    for svc in WATCHED_SERVICES:
        short = svc.removeprefix("claude-").removeprefix("watchdog-").removesuffix(".service")
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
                key = f"service:{svc}"
                if should_alert(key):
                    alerts.append(f"kiba:alert service={svc} status={status}")
        except Exception as e:
            log.warning(f"Error checking {svc}: {e}")
    return alerts


def check_tmux_sessions(paused: set[str] = frozenset()) -> list[str]:
    alerts = []
    try:
        r = subprocess.run(
            ["tmux", "list-sessions", "-F", "#{session_name}"],
            capture_output=True, text=True, timeout=5
        )
        active = set(r.stdout.strip().split("\n")) if r.returncode == 0 else set()
        for session in WATCHED_SESSIONS:
            if session in paused:
                continue
            if session not in active:
                key = f"tmux:{session}"
                if should_alert(key):
                    alerts.append(f"kiba:alert tmux=missing session={session}")
            else:
                # Check for stuck paste mode via pane_in_mode (not text grep — avoids false positives)
                try:
                    mode = subprocess.check_output(
                        ["tmux", "display-message", "-pt", session, "#{pane_in_mode}"], timeout=3
                    ).decode("utf-8", errors="replace").strip()
                    if mode == "1":
                        key = f"tmux:{session}:pasted"
                        if should_alert(key):
                            alerts.append(f"kiba:alert tmux=stuck_paste session={session}")
                except Exception:
                    pass

                # Detect compacting loop / stuck agent (#39)
                try:
                    pane = subprocess.check_output(
                        ["tmux", "capture-pane", "-pt", session], timeout=3
                    ).decode("utf-8", errors="replace")
                    lines = [l.strip() for l in pane.strip().split("\n")]
                    is_idle = any(
                        (l == "❯" or l == "❯\xa0" or l.startswith("❯ ") or l.startswith("❯\xa0"))
                        and "Pasted text" not in l
                        for l in lines[-6:]
                    )
                    now_mono = time.monotonic()
                    if is_idle:
                        _last_idle[session] = now_mono
                    else:
                        last_idle = _last_idle.get(session, now_mono)
                        non_idle_secs = now_mono - last_idle
                        is_compacting = any("ompacting" in l for l in lines[-10:])
                        if is_compacting and non_idle_secs >= COMPACTING_TIMEOUT:
                            key = f"tmux:{session}:compacting"
                            if should_alert(key):
                                mins = int(non_idle_secs // 60)
                                alerts.append(
                                    f"kiba:alert agent={session} compacting_loop duration={mins}min"
                                )
                        elif not is_compacting and non_idle_secs >= STUCK_TIMEOUT:
                            key = f"tmux:{session}:stuck"
                            if should_alert(key):
                                mins = int(non_idle_secs // 60)
                                alerts.append(
                                    f"kiba:alert agent={session} stuck duration={mins}min"
                                )

                    # Detect permission prompt freeze (#69)
                    # Filter out status-bar lines (e.g. "bypass permissions on (shift+tab to cycle)")
                    STATUS_BAR_NOISE = ["bypass permissions", "shift+tab", "bypassPermissions"]
                    prompt_lines = [l for l in lines[-15:] if not any(n in l for n in STATUS_BAR_NOISE)]
                    pane_text = "\n".join(prompt_lines)
                    PERMISSION_PATTERNS = [
                        "Do you want to proceed",
                        "(Y/n)",
                        "(y/N)",
                    ]
                    if any(p in pane_text for p in PERMISSION_PATTERNS):
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


def check_orphaned_sessions(paused: set[str] = frozenset()) -> list[str]:
    """Alert when agent tmux session is alive but watchdog service is inactive (#98).

    Scenario: watchdog stopped (e.g. OOM killer, manual stop) but agent tmux was later
    restarted without the watchdog. Agent receives no Konoha messages silently.
    """
    alerts = []
    try:
        r = subprocess.run(
            ["tmux", "list-sessions", "-F", "#{session_name}"],
            capture_output=True, text=True, timeout=5
        )
        active_sessions = set(r.stdout.strip().split("\n")) if r.returncode == 0 else set()

        for agent, watchdog_svc in AGENT_WATCHDOGS.items():
            if agent in paused or watchdog_svc in paused:
                continue
            if agent not in active_sessions:
                continue  # session not running — normal for on-demand agents, skip
            # Session alive — watchdog must also be active
            try:
                r = subprocess.run(
                    ["systemctl", "is-active", watchdog_svc],
                    capture_output=True, text=True, timeout=5
                )
                status = r.stdout.strip()
                if status not in ("active", "activating"):
                    key = f"orphan:{agent}:watchdog_dead"
                    if should_alert(key):
                        alerts.append(
                            f"kiba:alert agent={agent} watchdog=dead session=alive"
                        )
            except Exception as e:
                log.warning(f"Error checking watchdog status for {agent}: {e}")
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
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "--max-time", "5",
            "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
            f"{KONOHA_URL}/agents",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        if proc.returncode != 0 or not stdout:
            if should_alert("konoha:down"):
                alerts.append("kiba:alert konoha=down")
            return alerts

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

    # Send initial healthcheck trigger after 30s startup grace
    await asyncio.sleep(30)

    check_count = 0
    while True:
        check_count += 1
        alerts: list[str] = []

        # Run sync checks in thread pool to avoid blocking
        loop = asyncio.get_running_loop()
        paused = load_paused()
        svc_alerts      = await loop.run_in_executor(None, lambda: check_services(paused))
        tmux_alerts     = await loop.run_in_executor(None, lambda: check_tmux_sessions(paused))
        orphan_alerts   = await loop.run_in_executor(None, lambda: check_orphaned_sessions(paused))
        redis_alerts    = await loop.run_in_executor(None, check_redis)
        disk_alerts     = await loop.run_in_executor(None, check_disk)
        konoha_alerts   = await check_konoha(paused)

        alerts = svc_alerts + tmux_alerts + orphan_alerts + redis_alerts + disk_alerts + konoha_alerts

        # Re-read paused at send time (defense-in-depth: file may have been created
        # after the check pass, or an individual check may have missed the filter)
        paused = load_paused()
        alerts = [a for a in alerts if not is_alert_suppressed(a, paused)]

        if alerts:
            log.warning(f"Found {len(alerts)} alert(s): {alerts}")
            for alert in alerts:
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
