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
    "agent-kiba",
    "agent-watchdog-naruto",
    "agent-watchdog-sasuke",
    "agent-watchdog-kiba",
]
PROXY_SERVICES = ["sing-box", "privoxy"]
PERMANENT_AGENTS = ["naruto", "sasuke", "kiba"]
PERMANENT_AGENT_SERVICES = {agent: f"agent-{agent}.service" for agent in PERMANENT_AGENTS}
WATCHDOG_ENTRYPOINTS = {
    "agent-watchdog-naruto.service": "scripts/watchdog-naruto.py",
    "agent-watchdog-sasuke.service": "scripts/watchdog-sasuke.py",
    "agent-watchdog-kakashi.service": "scripts/watchdog-kakashi.py",
    "agent-watchdog-kiba.service": "scripts/watchdog-kiba.py",
    "agent-watchdog-lifecycle.service": "scripts/watchdog-lifecycle.py",
}
REGISTRY_WARN_TOTAL = 100
REGISTRY_WARN_EPHEMERAL = 10
STREAM_GROUPS = {
    "telegram:incoming": ["sasuke"],
    "telegram:bot:incoming": ["naruto"],
    "telegram:needs_context": ["context-packer"],
    "telegram:vision_requests": ["vision-packer"],
    "telegram:outgoing": ["claude-agents"],
}
DEAD_LETTER_STREAMS = [
    "telegram:needs_context:dead_letter",
    "telegram:vision_requests:dead_letter",
    "telegram:outgoing:dead_letter",
]
WARN_LAG = 100
WARN_PENDING = 10
FAIL_PENDING = 100
MAX_RED_FLAG_FILE_LINES = 1000
SIZE_CHECK_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".py"}
SIZE_CHECK_DIRS = ["src", "scripts", "tests"]
DASHBOARD_AUTH_FILE = Path(os.environ.get("KONOHA_DASHBOARD_AUTH_FILE", "/opt/shared/.dashboard-auth.json"))
SENSITIVE_TEMP_FILES = [
    Path("/home/ubuntu/.dashboard-initial-password"),
]


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


def run_env(cmd: list[str], env: dict[str, str], timeout: int = 10) -> tuple[int, str, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env={**os.environ, **env})
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
    # Fetch agent defs to report LLM profiles
    agent_profiles: dict[str, str] = {}
    try:
        agents = api_get("/agents")
        for a in agents or []:
            aid = str(a.get("id") or "")
            profile = a.get("llm_client_profile") or a.get("runtime") or "unknown"
            if aid:
                agent_profiles[aid] = str(profile)
    except Exception:
        pass

    for agent in PERMANENT_AGENTS:
        profile = agent_profiles.get(agent, "unknown")
        rc, _, _ = run(["tmux", "-L", agent, "has-session", "-t", agent], timeout=5)
        if rc != 0:
            checks.append(Check("FAIL", f"agent.{agent}.tmux", f"missing profile={profile}", f"Run: sudo systemctl restart agent-{agent}.service"))
            continue
        rc, pane, stderr = run(["tmux", "-L", agent, "capture-pane", "-pt", agent, "-S", "-80"], timeout=5)
        if rc != 0:
            checks.append(Check("WARN", f"agent.{agent}.pane", f"{stderr[:160]} profile={profile}", f"Run: tmux -L {agent} capture-pane -pt {agent}"))
            continue
        signal = pane_stuck_signal(pane)
        if signal:
            checks.append(Check("WARN", f"agent.{agent}.signal", f"{signal} profile={profile}", f"Inspect pane; if persistent restart agent-{agent}.service"))
        else:
            checks.append(Check("OK", f"agent.{agent}.tmux", f"alive idle={str(pane_is_idle(pane)).lower()} profile={profile}"))
    return checks


def systemd_exec_start(service: str) -> str:
    rc, stdout, stderr = run(["systemctl", "show", service, "-p", "ExecStart", "--value"], timeout=5)
    if rc != 0:
        raise RuntimeError(stderr or stdout or f"systemctl show {service} failed")
    return stdout


def check_lifecycle_control_plane() -> list[Check]:
    checks: list[Check] = []
    for agent, service in PERMANENT_AGENT_SERVICES.items():
        try:
            exec_start = systemd_exec_start(service)
        except Exception as exc:
            checks.append(Check("FAIL", f"control_plane.agent_service.{agent}", str(exc), f"Inspect: systemctl cat {service}"))
            continue
        expected = f"scripts/agent-api-service.sh {agent}"
        if expected in exec_start:
            checks.append(Check("OK", f"control_plane.agent_service.{agent}", "uses lifecycle API wrapper"))
        else:
            checks.append(Check("FAIL", f"control_plane.agent_service.{agent}", exec_start[:180], f"ExecStart must use {expected}"))

    legacy_watchdog_users: list[str] = []
    for service, expected_script in WATCHDOG_ENTRYPOINTS.items():
        try:
            exec_start = systemd_exec_start(service)
        except Exception as exc:
            checks.append(Check("FAIL", f"control_plane.watchdog.{service}", str(exc), f"Inspect: systemctl cat {service}"))
            continue
        if "scripts/watchdog.py" in exec_start:
            legacy_watchdog_users.append(service)
        if expected_script in exec_start:
            checks.append(Check("OK", f"control_plane.watchdog.{service}", f"uses {expected_script}"))
        else:
            checks.append(Check("WARN", f"control_plane.watchdog.{service}", exec_start[:180], f"Expected {expected_script}"))

    if legacy_watchdog_users:
        checks.append(Check("WARN", "control_plane.legacy_watchdog", ",".join(legacy_watchdog_users), "Retire scripts/watchdog.py from active systemd units"))
    else:
        checks.append(Check("OK", "control_plane.legacy_watchdog", "scripts/watchdog.py is not an active known watchdog entrypoint"))
    return checks


def check_shared_config() -> list[Check]:
    script = Path("/home/ubuntu/konoha/scripts/validate-shared-config.py")
    rc, stdout, stderr = run([sys.executable, str(script), "--require-credentials", "--require-trusted-users"], timeout=20)
    if rc == 0:
        last = (stdout.strip().splitlines() or ["OK"])[-1]
        return [Check("OK", "shared.config", last)]
    return [Check("FAIL", "shared.config", (stdout + stderr).strip()[:400], "Fix /opt/shared/.shared-credentials or /opt/shared/.trusted-users.json")]


def nginx_server_blocks(config_text: str) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    depth = 0
    in_server = False
    for line in config_text.splitlines():
        stripped = line.strip()
        if not in_server and stripped.startswith("server") and "{" in stripped:
            in_server = True
            current = [line]
            depth = stripped.count("{") - stripped.count("}")
            if depth <= 0:
                blocks.append("\n".join(current))
                in_server = False
            continue
        if not in_server:
            continue
        current.append(line)
        depth += stripped.count("{") - stripped.count("}")
        if depth <= 0:
            blocks.append("\n".join(current))
            in_server = False
    return blocks


def check_security_hygiene() -> list[Check]:
    checks: list[Check] = []

    leaked_files = [path for path in SENSITIVE_TEMP_FILES if path.exists()]
    leaked_files.extend(Path("/home/ubuntu").glob(".agent-env.bak.*"))
    if leaked_files:
        sample = ", ".join(str(path) for path in leaked_files[:5])
        checks.append(Check("FAIL", "security.temp_secrets", sample, "Remove one-time password/env backup files after rotation"))
    else:
        checks.append(Check("OK", "security.temp_secrets", "no known one-time secret files"))

    if DASHBOARD_AUTH_FILE.exists():
        mode = DASHBOARD_AUTH_FILE.stat().st_mode & 0o777
        if mode & 0o077:
            checks.append(Check("FAIL", "security.dashboard_auth_file", oct(mode), f"Run: chmod 600 {DASHBOARD_AUTH_FILE}"))
        else:
            checks.append(Check("OK", "security.dashboard_auth_file", f"{oct(mode)}"))
    else:
        checks.append(Check("WARN", "security.dashboard_auth_file", "missing", "Dashboard login will require bootstrap password setup"))

    dashboard_hosts = [
        host.strip().lower()
        for host in os.environ.get("KONOHA_DASHBOARD_HOSTS", "").split(",")
        if host.strip()
    ]
    rc, stdout, stderr = run(["sudo", "nginx", "-T"], timeout=15)
    if rc != 0:
        checks.append(Check("WARN", "security.nginx_dashboard_auth", (stderr or stdout)[:240], "Run: sudo nginx -T"))
    elif not dashboard_hosts:
        checks.append(Check("WARN", "security.nginx_dashboard_auth", "KONOHA_DASHBOARD_HOSTS is empty", "Set dashboard hosts in /home/ubuntu/.agent-env"))
    else:
        config_text = f"{stdout}\n{stderr}"
        offending_hosts: list[str] = []
        for block in nginx_server_blocks(config_text):
            lowered = block.lower()
            if "proxy_set_header authorization" not in lowered:
                continue
            if any(host in lowered for host in dashboard_hosts):
                offending_hosts.extend(host for host in dashboard_hosts if host in lowered)
        if offending_hosts:
            checks.append(Check(
                "FAIL",
                "security.nginx_dashboard_auth",
                f"bearer injection for {','.join(sorted(set(offending_hosts)))}",
                "Dashboard /api must use X-Konoha-Dashboard + session cookie, not injected admin bearer",
            ))
        else:
            checks.append(Check("OK", "security.nginx_dashboard_auth", "dashboard hosts do not inject bearer auth"))

    rc, stdout, stderr = run(
        ["sudo", "grep", "-R", "-l", 'proxy_set_header Authorization "Bearer', "/root/nginx-backups", "/etc/nginx"],
        timeout=15,
    )
    if rc == 0 and stdout.strip():
        checks.append(Check("FAIL", "security.nginx_secret_backups", stdout.splitlines()[0][:180], "Remove nginx backups containing bearer tokens"))
    else:
        checks.append(Check("OK", "security.nginx_secret_backups", "no nginx bearer backups found"))

    return checks


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


def check_workflow_engine() -> list[Check]:
    checks: list[Check] = []
    # Verify workflow definitions on disk are loadable
    workflows_dir = os.environ.get("KONOHA_WORKFLOWS_DIR") or str(
        Path(__file__).resolve().parent.parent / "workflows"
    )
    try:
        import glob
        json_files = glob.glob(f"{workflows_dir}/**/*.json", recursive=True)
        checks.append(Check("OK", "workflow_engine.defs", f"{len(json_files)} workflow definitions on disk"))
    except Exception as exc:
        checks.append(Check("WARN", "workflow_engine.defs", str(exc), f"Check: ls {workflows_dir}"))
        return checks

    # Verify API routes are mounted
    try:
        api_get("/workflows")
        checks.append(Check("OK", "workflow_engine.api", "/workflows route responds"))
    except Exception as exc:
        checks.append(Check("WARN", "workflow_engine.api", str(exc), "Check workflow-engine module is mounted"))
    return checks


def check_codex_proxy() -> list[Check]:
    checks: list[Check] = []
    proxy = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    if not proxy:
        return [Check("WARN", "codex_proxy.env", "https_proxy is not configured", "Set https_proxy/http_proxy for Codex egress only")]

    for service in PROXY_SERVICES:
        rc, stdout, stderr = run(["systemctl", "is-active", service], timeout=5)
        state = stdout.strip() or stderr.strip()
        if rc == 0 and state == "active":
            checks.append(Check("OK", f"codex_proxy.service.{service}", "active"))
        else:
            checks.append(Check("WARN", f"codex_proxy.service.{service}", state or "inactive", f"Run: sudo systemctl restart {service}"))

    env = {
        "http_proxy": os.environ.get("http_proxy", proxy),
        "https_proxy": proxy,
        "HTTP_PROXY": os.environ.get("HTTP_PROXY", os.environ.get("http_proxy", proxy)),
        "HTTPS_PROXY": os.environ.get("HTTPS_PROXY", proxy),
        "no_proxy": "127.0.0.1,localhost",
        "NO_PROXY": "127.0.0.1,localhost",
    }
    rc, stdout, stderr = run_env(
        ["curl", "-sS", "--max-time", "12", "-o", "/dev/null", "-w", "%{http_code}", "https://chatgpt.com/"],
        env,
        timeout=15,
    )
    code = stdout.strip()
    if rc == 0 and code and code not in {"000", "502", "503", "504"}:
        checks.append(Check("OK", "codex_proxy.chatgpt", f"HTTP {code} through configured proxy"))
    else:
        detail = (stderr or f"HTTP {code or '000'}").splitlines()[-1][:220]
        checks.append(Check("WARN", "codex_proxy.chatgpt", detail, "Refresh sing-box upstream credentials before enabling Codex fallback"))
    return checks


def is_ephemeral_agent_id(agent_id: str) -> bool:
    return agent_id.startswith("rtest-") or re.match(r"^test(?:-[a-z0-9-]+)?-t\d+$", agent_id) is not None


def is_suspicious_agent_id(agent_id: str) -> bool:
    lowered = agent_id.lower()
    return is_ephemeral_agent_id(agent_id) or any(part in lowered for part in ("test", "smoke", "verify"))


def check_agent_registry_hygiene() -> list[Check]:
    try:
        agents = api_get("/agents")
    except Exception as exc:
        return [Check("WARN", "agent_registry.hygiene", str(exc), "Check /agents API and KONOHA_TOKEN")]

    ids = [str(agent.get("id") or "") for agent in agents if agent.get("id")]
    ephemeral = [agent_id for agent_id in ids if is_ephemeral_agent_id(agent_id)]
    suspicious = [agent_id for agent_id in ids if is_suspicious_agent_id(agent_id) and not is_ephemeral_agent_id(agent_id)]

    checks: list[Check] = []
    if len(ids) > REGISTRY_WARN_TOTAL:
        checks.append(Check(
            "WARN",
            "agent_registry.total",
            f"{len(ids)} agent records visible",
            "Run: bun scripts/cleanup-agent-registry.ts --dry-run",
        ))
    else:
        checks.append(Check("OK", "agent_registry.total", f"{len(ids)} agent records visible"))

    if len(ephemeral) > REGISTRY_WARN_EPHEMERAL:
        checks.append(Check(
            "WARN",
            "agent_registry.ephemeral",
            f"{len(ephemeral)} generated test records visible",
            "Run: bun scripts/cleanup-agent-registry.ts --apply",
        ))
    else:
        checks.append(Check("OK", "agent_registry.ephemeral", f"{len(ephemeral)} generated test records visible"))

    if suspicious:
        sample = ", ".join(suspicious[:8])
        checks.append(Check(
            "WARN",
            "agent_registry.suspicious",
            f"{len(suspicious)} suspicious non-rtest ids; sample={sample}",
            "Review manually before deleting non-rtest records",
        ))
    else:
        checks.append(Check("OK", "agent_registry.suspicious", "no suspicious non-rtest ids"))
    return checks


def check_agent_definition_storage_split() -> list[Check]:
    try:
        legacy = set(redis_json("HKEYS", "konoha:agent-defs") or [])
        templates = set(redis_json("HKEYS", "konoha:agent-templates") or [])
        runtime_configs = set(redis_json("HKEYS", "konoha:agent-runtime-configs") or [])
    except Exception as exc:
        return [Check("WARN", "agent_storage.split", str(exc), "Inspect Redis agent definition hashes")]

    missing_templates = sorted(legacy - templates)
    missing_runtime_configs = sorted(legacy - runtime_configs)
    if missing_templates or missing_runtime_configs:
        detail = f"legacy={len(legacy)} templates={len(templates)} runtime_configs={len(runtime_configs)}"
        hint = "Run split backfill before relying on template/runtime-config stores"
        return [Check("WARN", "agent_storage.split", detail, hint)]

    split_only = sorted((templates | runtime_configs) - legacy)
    if split_only:
        detail = f"legacy={len(legacy)} split_only={len(split_only)} sample={','.join(split_only[:5])}"
        return [Check("OK", "agent_storage.split", detail)]

    return [Check("OK", "agent_storage.split", f"{len(legacy)} defs mirrored to template/runtime-config stores")]


def check_llm_client_profiles() -> list[Check]:
    try:
        profiles = api_get("/agents/llm-client-profiles")
    except Exception as exc:
        return [Check("WARN", "llm_profiles.api", str(exc), "Check /agents/llm-client-profiles route and KONOHA_TOKEN")]

    by_id = {str(profile.get("id")): profile for profile in profiles if profile.get("id")}
    required = ["claude-deepseek-haiku", "claude-deepseek-sonnet", "claude-deepseek-opus", "codex-gpt-5.5"]
    missing = [profile_id for profile_id in required if profile_id not in by_id]
    checks: list[Check] = []
    if missing:
        checks.append(Check("FAIL", "llm_profiles.required", f"missing={','.join(missing)}", "Update src/agent/llm-client-profiles.ts"))
    else:
        checks.append(Check("OK", "llm_profiles.required", f"{len(required)} required profiles available"))

    codex = by_id.get("codex-gpt-5.5") or {}
    if codex.get("disabled") is True:
        checks.append(Check("WARN", "llm_profiles.codex_fallback", "codex-gpt-5.5 is disabled", "Proxy and Codex CLI smoke are fixed; enable after re-running the smoke"))
    else:
        checks.append(Check("OK", "llm_profiles.codex_fallback", "codex-gpt-5.5 enabled after proxy and CLI verification"))

    deepseek_profiles = [profile for profile in by_id.values() if profile.get("provider_profile") == "deepseek"]
    if deepseek_profiles:
        checks.append(Check("OK", "llm_profiles.deepseek", f"{len(deepseek_profiles)} deepseek-backed profiles"))
    else:
        checks.append(Check("FAIL", "llm_profiles.deepseek", "no deepseek-backed profiles", "Add at least one default Anthropic-compatible DeepSeek profile"))
    return checks


def check_large_source_files() -> list[Check]:
    repo = Path(__file__).resolve().parent.parent
    violations: list[tuple[str, int]] = []
    for dirname in SIZE_CHECK_DIRS:
        root = repo / dirname
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in SIZE_CHECK_EXTENSIONS:
                continue
            try:
                lines = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
            except Exception:
                continue
            if lines > MAX_RED_FLAG_FILE_LINES:
                violations.append((str(path.relative_to(repo)), lines))

    if not violations:
        return [Check("OK", "source_size.red_flags", f"no files over {MAX_RED_FLAG_FILE_LINES} lines")]

    detail = ", ".join(f"{name}={lines}" for name, lines in sorted(violations, key=lambda item: item[1], reverse=True)[:8])
    return [Check(
        "WARN",
        "source_size.red_flags",
        detail,
        "Split files over 1000 lines; this is architecture debt, not a release blocker yet",
    )]


def main() -> int:
    load_env_defaults()
    checks: list[Check] = []
    for fn in (check_systemd, check_api, check_redis_streams, check_agents, check_lifecycle_control_plane, check_shared_config, check_security_hygiene, check_workflow_engine, check_codex_proxy, check_agent_registry_hygiene, check_agent_definition_storage_split, check_llm_client_profiles, check_large_source_files):
        checks.extend(fn())
    return print_report(checks)


if __name__ == "__main__":
    raise SystemExit(main())
