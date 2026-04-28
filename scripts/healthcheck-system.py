#!/usr/bin/env python3
"""Konoha production healthcheck with actionable, redacted output."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


KONOHA_URL = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200").rstrip("/")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
ENV_FILES = [Path("/home/ubuntu/.agent-env"), Path("/opt/shared/.shared-credentials")]

CORE_SERVICES = [
    "konoha",
    "akamaru",
    "telegram-bot",
    "telegram-bus",
    "telegram-context-packer",
    "telegram-vision-packer",
    "agent-watchdog-lifecycle",
    "agent-naruto",
    "agent-sasuke",
    "agent-kakashi",
    "agent-kiba",
    "agent-watchdog-naruto",
    "agent-watchdog-sasuke",
    "agent-watchdog-kakashi",
    "agent-watchdog-kiba",
]
PERMANENT_AGENTS = ["naruto", "sasuke", "kakashi", "kiba"]
STREAM_GROUPS = {
    "telegram:incoming": ["sasuke"],
    "telegram:bot:incoming": ["naruto"],
    "telegram:needs_context": ["context-packer"],
    "telegram:vision_requests": ["vision-packer"],
    "telegram:outgoing": ["claude-agents"],
}
DEAD_LETTER_STREAMS = ["telegram:needs_context:dead_letter", "telegram:vision_requests:dead_letter"]
WARN_LAG = 100
WARN_PENDING = 10
FAIL_PENDING = 100


@dataclass
class Check:
    level: str
    name: str
    detail: str
    hint: str = ""


def load_env_defaults() -> None:
    for path in ENV_FILES:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.removeprefix("export ").strip()
            if key and key not in os.environ:
                os.environ[key] = value.strip().strip("\"'")


def run(cmd: list[str], timeout: int = 10) -> tuple[int, str, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def redis_json(*args: str) -> Any:
    rc, stdout, stderr = run(["redis-cli", "--json", *args], timeout=8)
    if rc != 0:
        raise RuntimeError(stderr or stdout or f"redis-cli {' '.join(args)} failed")
    if not stdout:
        return None
    return json.loads(stdout)


def api_get(path: str) -> Any:
    token = os.environ.get("KONOHA_TOKEN") or KONOHA_TOKEN
    base_url = (os.environ.get("KONOHA_URL") or KONOHA_URL).rstrip("/")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(f"{base_url}{path}", headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def pane_is_idle(content: str) -> bool:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    last = lines[-12:]
    return (
        any((line == "❯" or line.startswith("❯ ") or line.startswith("› ")) and "Pasted text" not in line for line in last)
        or any("ctrl+p commands" in line or "tab agents" in line for line in last)
        or any("→ Add a follow-up" in line or "ctrl+c to stop" in line for line in last)
    )


def pane_stuck_signal(content: str) -> str:
    tail = "\n".join([line.strip() for line in content.splitlines() if line.strip()][-20:])
    lowered = tail.lower()
    if "pasted text" in tail:
        return "stuck_paste"
    if "compacting" in lowered or "compact" in lowered:
        return "compacting"
    if "rate limit" in lowered:
        return "rate_limit"
    for line in lowered.splitlines():
        if "permission" in line and ("allow" in line or "approve" in line) and "bypass permissions on" not in line:
            return "permission_prompt"
    return ""


def check_systemd() -> list[Check]:
    checks: list[Check] = []
    rc, stdout, stderr = run(["systemctl", "--failed", "--no-pager"], timeout=10)
    failed_output = stdout + stderr
    if rc == 0 and "0 loaded units listed" in failed_output:
        checks.append(Check("OK", "systemd.failed", "no failed units"))
    else:
        checks.append(Check("FAIL", "systemd.failed", failed_output[:240], "Run: systemctl --failed --no-pager"))

    rc, stdout, stderr = run(["systemctl", "is-active", *CORE_SERVICES], timeout=15)
    states = stdout.splitlines()
    for service, state in zip(CORE_SERVICES, states):
        if state == "active":
            checks.append(Check("OK", f"service.{service}", "active"))
        else:
            checks.append(Check("FAIL", f"service.{service}", state or stderr[:120], f"Run: sudo systemctl restart {service}"))
    return checks


def check_api() -> list[Check]:
    checks: list[Check] = []
    try:
        health = api_get("/health")
        checks.append(Check("OK", "konoha.api", f"/health status={health.get('status')}"))
    except Exception as exc:
        checks.append(Check("FAIL", "konoha.api", str(exc), "Run: sudo systemctl restart konoha && journalctl -u konoha -n 100"))
        return checks

    try:
        agents = api_get("/agents")
        checks.append(Check("OK", "konoha.agents", f"{len(agents)} agent definitions visible"))
    except Exception as exc:
        checks.append(Check("WARN", "konoha.agents", str(exc), "Check KONOHA_TOKEN and /agents route"))
    return checks


def check_redis_streams() -> list[Check]:
    checks: list[Check] = []
    try:
        if redis_json("PING") != "PONG":
            checks.append(Check("FAIL", "redis.ping", "unexpected PING response", "Run: sudo systemctl restart redis-server"))
            return checks
        checks.append(Check("OK", "redis.ping", "PONG"))
    except Exception as exc:
        return [Check("FAIL", "redis.ping", str(exc), "Run: sudo systemctl restart redis-server")]

    for stream, expected_groups in STREAM_GROUPS.items():
        try:
            length = int(redis_json("XLEN", stream) or 0)
            groups = redis_json("XINFO", "GROUPS", stream)
        except Exception as exc:
            checks.append(Check("WARN", f"redis.stream.{stream}", str(exc), f"Create stream/group or inspect: redis-cli XINFO GROUPS {stream}"))
            continue

        by_name = {group.get("name"): group for group in groups or []}
        for group_name in expected_groups:
            group = by_name.get(group_name)
            if not group:
                checks.append(Check("FAIL", f"redis.stream.{stream}.{group_name}", f"group missing; len={length}", f"Restart owning service or create consumer group for {stream}"))
                continue
            pending = int(group.get("pending") or 0)
            lag = int(group.get("lag") or 0)
            consumers = int(group.get("consumers") or 0)
            detail = f"len={length} group={group_name} consumers={consumers} pending={pending} lag={lag}"
            if pending >= FAIL_PENDING:
                checks.append(Check("FAIL", f"redis.stream.{stream}.{group_name}", detail, f"Inspect: redis-cli XPENDING {stream} {group_name}"))
            elif pending > WARN_PENDING or lag > WARN_LAG:
                checks.append(Check("WARN", f"redis.stream.{stream}.{group_name}", detail, f"Inspect lag/pending and restart owning packer/watchdog if growing"))
            else:
                checks.append(Check("OK", f"redis.stream.{stream}.{group_name}", detail))

    for stream in DEAD_LETTER_STREAMS:
        try:
            length = int(redis_json("XLEN", stream) or 0)
        except Exception:
            length = 0
        if length:
            checks.append(Check("WARN", f"redis.dead_letter.{stream}", f"len={length}", f"Inspect: redis-cli XRANGE {stream} - + COUNT 10"))
        else:
            checks.append(Check("OK", f"redis.dead_letter.{stream}", "empty"))
    return checks


def check_agents() -> list[Check]:
    checks: list[Check] = []
    for agent in PERMANENT_AGENTS:
        rc, _, _ = run(["tmux", "-L", agent, "has-session", "-t", agent], timeout=5)
        if rc != 0:
            checks.append(Check("FAIL", f"agent.{agent}.tmux", "missing", f"Run: sudo systemctl restart agent-{agent}.service"))
            continue
        rc, pane, stderr = run(["tmux", "-L", agent, "capture-pane", "-pt", agent, "-S", "-80"], timeout=5)
        if rc != 0:
            checks.append(Check("WARN", f"agent.{agent}.pane", stderr[:160], f"Run: tmux -L {agent} capture-pane -pt {agent}"))
            continue
        signal = pane_stuck_signal(pane)
        if signal:
            checks.append(Check("WARN", f"agent.{agent}.signal", signal, f"Inspect pane; if persistent restart agent-{agent}.service"))
        else:
            checks.append(Check("OK", f"agent.{agent}.tmux", "alive idle=" + str(pane_is_idle(pane)).lower()))
    return checks


def check_shared_config() -> list[Check]:
    script = Path("/home/ubuntu/konoha/scripts/validate-shared-config.py")
    rc, stdout, stderr = run([sys.executable, str(script), "--require-credentials", "--require-trusted-users"], timeout=20)
    if rc == 0:
        last = (stdout.strip().splitlines() or ["OK"])[-1]
        return [Check("OK", "shared.config", last)]
    return [Check("FAIL", "shared.config", (stdout + stderr).strip()[:400], "Fix /opt/shared/.shared-credentials or /opt/shared/.trusted-users.json")]


def print_report(checks: list[Check]) -> int:
    order = {"FAIL": 0, "WARN": 1, "OK": 2}
    for check in sorted(checks, key=lambda item: (order[item.level], item.name)):
        print(f"{check.level:4} {check.name}: {check.detail}")
        if check.hint and check.level != "OK":
            print(f"     hint: {check.hint}")
    fails = sum(1 for check in checks if check.level == "FAIL")
    warns = sum(1 for check in checks if check.level == "WARN")
    oks = sum(1 for check in checks if check.level == "OK")
    print(f"\nsummary: {oks} OK, {warns} WARN, {fails} FAIL")
    return 2 if fails else 0


def main() -> int:
    load_env_defaults()
    checks: list[Check] = []
    for fn in (check_systemd, check_api, check_redis_streams, check_agents, check_shared_config):
        checks.extend(fn())
    return print_report(checks)


if __name__ == "__main__":
    raise SystemExit(main())
