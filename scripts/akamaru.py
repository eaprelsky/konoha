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
]

WATCHED_SESSIONS = ["naruto", "sasuke", "mirai", "jiraiya", "shino", "hinata", "kiba"]
WATCHED_AGENTS   = ["naruto", "sasuke", "mirai", "jiraiya", "shino", "hinata", "kiba"]

LOG_FILE = "/tmp/akamaru.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
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


# ── Check functions ───────────────────────────────────────────────────────────

def check_services() -> list[str]:
    alerts = []
    for svc in WATCHED_SERVICES:
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


def check_tmux_sessions() -> list[str]:
    alerts = []
    try:
        r = subprocess.run(
            ["tmux", "list-sessions", "-F", "#{session_name}"],
            capture_output=True, text=True, timeout=5
        )
        active = set(r.stdout.strip().split("\n")) if r.returncode == 0 else set()
        for session in WATCHED_SESSIONS:
            if session not in active:
                key = f"tmux:{session}"
                if should_alert(key):
                    alerts.append(f"kiba:alert tmux=missing session={session}")
    except Exception as e:
        log.warning(f"Error checking tmux: {e}")
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


async def check_konoha() -> list[str]:
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
        loop = asyncio.get_event_loop()
        svc_alerts  = await loop.run_in_executor(None, check_services)
        tmux_alerts = await loop.run_in_executor(None, check_tmux_sessions)
        redis_alerts = await loop.run_in_executor(None, check_redis)
        disk_alerts  = await loop.run_in_executor(None, check_disk)
        konoha_alerts = await check_konoha()

        alerts = svc_alerts + tmux_alerts + redis_alerts + disk_alerts + konoha_alerts

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
