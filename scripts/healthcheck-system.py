#!/usr/bin/env python3
"""Konoha production healthcheck with actionable, redacted output."""

# Boundary note:
# This script is infrastructure monitor runtime. It reports raw deployment
# health and readiness. Operator decisions, escalation, and post-incident
# follow-up should be represented as workflow-visible reliability cases; see
# docs/monitor-reliability-boundary.md.

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from service_profiles import resolve_service_profile_from_env


KONOHA_URL = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200").rstrip("/")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
ENV_FILES = [Path("/home/ubuntu/.agent-env"), Path("/opt/shared/.shared-credentials")]
ROSTER_PATH = Path(__file__).resolve().parents[1] / "docs" / "system-agent-roster.json"
RESOURCE_INVENTORY_SCRIPT = SCRIPT_DIR / "resource-inventory.py"


def load_system_agent_roster(path: Path = ROSTER_PATH) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def default_enabled_optional_monitors_from_roster(path: Path = ROSTER_PATH) -> set[str]:
    try:
        roster = load_system_agent_roster(path)
        defaults = {
            str(agent["id"])
            for agent in roster.get("agents", [])
            if agent.get("health_policy") == "optional_monitor_default"
        }
        if defaults:
            return defaults
    except Exception:
        pass
    return {"akamaru", "kakashi", "kiba", "shikadai"}

CORE_SERVICES = [
    "konoha",
    "agent-watchdog-lifecycle",
]
CONNECTOR_OWNED_SERVICES = [
    "telegram-bot",
    "telegram-bus",
    "telegram-context-packer",
    "telegram-event-bridge",
    "telegram-vision-packer",
    "agent-naruto",
    "agent-sasuke",
    "agent-watchdog-naruto",
    "agent-watchdog-sasuke",
]
OPTIONAL_WORKER_SERVICES = [
    "akamaru",
    "agent-kiba",
    "agent-watchdog-kiba",
]
CONNECTOR_SERVICE_GROUPS = {
    "telegram": CONNECTOR_OWNED_SERVICES,
}
OPTIONAL_MONITOR_SERVICE_GROUPS = {
    "akamaru": ["akamaru"],
    "kiba": ["agent-kiba", "agent-watchdog-kiba"],
    "kakashi": ["agent-kakashi", "agent-watchdog-kakashi"],
    "shikadai": ["agent-watchdog-shikadai"],
}
SYSTEMD_SLICE_POLICIES = {
    "konoha.slice": {
        "classification": "required_core",
        "memory_high": "5500M",
        "memory_max": "6500M",
        "cpu_weight": "200",
        "cpu_quota": "600%",
        "tasks_max": "20000",
    },
    "konoha-core.slice": {
        "classification": "required_core",
        "memory_high": "900M",
        "memory_max": "1200M",
        "cpu_weight": "300",
        "cpu_quota": "200%",
        "tasks_max": "4096",
    },
    "konoha-connectors.slice": {
        "classification": "connector_owned",
        "connector": "telegram",
        "memory_high": "1600M",
        "memory_max": "2200M",
        "cpu_weight": "250",
        "cpu_quota": "300%",
        "tasks_max": "8192",
    },
    "konoha-agents.slice": {
        "classification": "optional_worker",
        "optional_monitors": {"akamaru", "kiba"},
        "memory_high": "900M",
        "memory_max": "1200M",
        "cpu_weight": "120",
        "cpu_quota": "175%",
        "tasks_max": "4096",
    },
    "konoha-qa.slice": {
        "classification": "qa_on_demand",
        "optional_monitors": {"kakashi", "shikadai", "shino", "hinata", "guy", "ibiki"},
        "memory_high": "1200M",
        "memory_max": "1800M",
        "cpu_weight": "100",
        "cpu_quota": "200%",
        "tasks_max": "8192",
    },
    "konoha-infra.slice": {
        "classification": "external_infra",
        "memory_high": "1500M",
        "memory_max": "2500M",
        "cpu_weight": "200",
        "cpu_quota": "250%",
        "tasks_max": "4096",
    },
}
SYSTEMD_SERVICE_SLICES = {
    "konoha.service": "konoha-core.slice",
    "agent-naruto.service": "konoha-connectors.slice",
    "agent-sasuke.service": "konoha-connectors.slice",
    "agent-watchdog-naruto.service": "konoha-connectors.slice",
    "agent-watchdog-sasuke.service": "konoha-connectors.slice",
    "telegram-bot.service": "konoha-connectors.slice",
    "telegram-bus.service": "konoha-connectors.slice",
    "telegram-context-packer.service": "konoha-connectors.slice",
    "telegram-event-bridge.service": "konoha-connectors.slice",
    "telegram-vision-packer.service": "konoha-connectors.slice",
    "akamaru.service": "konoha-agents.slice",
    "agent-kiba.service": "konoha-agents.slice",
    "agent-watchdog-kiba.service": "konoha-agents.slice",
    "agent-kakashi.service": "konoha-qa.slice",
    "agent-watchdog-kakashi.service": "konoha-qa.slice",
    "agent-watchdog-shikadai.service": "konoha-qa.slice",
    "agent-watchdog-lifecycle.service": "konoha-qa.slice",
    "agent-qa-watcher.service": "konoha-qa.slice",
}
LIFECYCLE_MANAGED_AGENT_SERVICE_SLICES = {
    "shino": "konoha-qa.slice",
    "hinata": "konoha-qa.slice",
    "ibiki": "konoha-qa.slice",
    "guy": "konoha-qa.slice",
}
CONNECTOR_AGENTS = {
    "naruto": "telegram",
    "sasuke": "telegram",
}
DEFAULT_ENABLED_CONNECTORS = {"telegram"}
DEFAULT_ENABLED_OPTIONAL_MONITORS = default_enabled_optional_monitors_from_roster()
PROXY_SERVICES = ["sing-box", "privoxy"]
AGENT_HEALTH_TARGETS = {
    "naruto": {"classification": "connector_owned", "service": "agent-naruto.service"},
    "sasuke": {"classification": "connector_owned", "service": "agent-sasuke.service"},
    "kiba": {"classification": "optional_worker", "service": "agent-kiba.service"},
    "kakashi": {"classification": "optional_worker", "service": "agent-kakashi.service"},
    "shikadai": {"classification": "optional_worker"},
    "shino": {"classification": "optional_worker"},
    "hinata": {"classification": "optional_worker"},
    "guy": {"classification": "optional_worker"},
}
DISABLED_EXPERIMENT_AGENTS = {
    "jiraiya": {
        "service": "agent-managed@jiraiya.service",
        "reason": "corporate-memory experiment disabled until explicit product need",
    },
}
PERMANENT_AGENT_SERVICES = {
    agent: str(meta["service"])
    for agent, meta in AGENT_HEALTH_TARGETS.items()
    if meta.get("service") and agent != "kakashi"
}
WATCHDOG_ENTRYPOINTS = {
    "agent-watchdog-naruto.service": "scripts/watchdog-naruto.py",
    "agent-watchdog-sasuke.service": "scripts/watchdog-sasuke.py",
    "agent-watchdog-kakashi.service": "scripts/watchdog-kakashi.py",
    "agent-watchdog-shikadai.service": "scripts/watchdog-shikadai.py",
    "agent-watchdog-kiba.service": "scripts/watchdog-kiba.py",
    "agent-watchdog-lifecycle.service": "scripts/watchdog-lifecycle.py",
}
REGISTRY_WARN_TOTAL = 100
REGISTRY_WARN_EPHEMERAL = 10
STREAM_GROUPS = {
    "telegram:incoming": ["sasuke"],
    "telegram:bot:incoming": ["naruto"],
    "telegram:reaction_updates": ["sasuke-reactions"],
    "telegram:needs_context": ["context-packer"],
    "telegram:log": ["event-bridge"],
    "telegram:vision_requests": ["vision-packer"],
    "telegram:outgoing": ["claude-agents"],
}
DEAD_LETTER_STREAMS = [
    "telegram:needs_context:dead_letter",
    "telegram:event_bridge:dead_letter",
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
HEALTH_POLICY_FILE = Path(os.environ.get("KONOHA_HEALTH_POLICY_FILE", "/opt/shared/konoha-health-policy.json"))
REDIS_COMMANDSTATS_STATE_FILE = Path(os.environ.get("KONOHA_REDIS_COMMANDSTATS_STATE_FILE", "/tmp/konoha-healthcheck-redis-commandstats.json"))
XREADGROUP_WARN_PER_SEC = float(os.environ.get("KONOHA_XREADGROUP_WARN_PER_SEC", "20"))
XGROUP_WARN_PER_SEC = float(os.environ.get("KONOHA_XGROUP_WARN_PER_SEC", "1"))


@dataclass
class Check:
    level: str
    name: str
    detail: str
    hint: str = ""


@dataclass(frozen=True)
class HealthcheckPolicy:
    enabled_connectors: frozenset[str]
    enabled_optional_monitors: frozenset[str]
    service_profile: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "service_profile": self.service_profile,
            "enabled_connectors": sorted(self.enabled_connectors),
            "enabled_optional_monitors": sorted(self.enabled_optional_monitors),
        }


def parse_policy_csv(value: str | None, default: set[str]) -> set[str]:
    if value is None:
        return set(default)
    normalized = value.strip().lower()
    if normalized in {"", "none", "off", "false", "0"}:
        return set()
    if normalized == "all":
        return set(default)
    return {item.strip() for item in value.split(",") if item.strip()}


def load_healthcheck_policy(environ: dict[str, str] | None = None, policy_file: Path | None = None) -> HealthcheckPolicy:
    env = environ or os.environ
    profile = resolve_service_profile_from_env(env)
    connectors = set(profile.enabled_connectors)
    optional_monitors = set(profile.enabled_optional_monitors)
    path = policy_file or Path(env.get("KONOHA_HEALTH_POLICY_FILE", str(HEALTH_POLICY_FILE)))

    if path.exists():
        raw = json.loads(path.read_text(encoding="utf-8"))
        if "enabled_connectors" in raw:
            connectors = {str(item) for item in raw.get("enabled_connectors") or []}
        if "enabled_optional_monitors" in raw:
            optional_monitors = {str(item) for item in raw.get("enabled_optional_monitors") or []}

    connector_env = env.get("KONOHA_HEALTH_ENABLED_CONNECTORS") or env.get("KONOHA_ENABLED_CONNECTORS")
    optional_env = env.get("KONOHA_HEALTH_ENABLED_OPTIONAL_MONITORS") or env.get("KONOHA_ENABLED_OPTIONAL_MONITORS")
    connectors = parse_policy_csv(connector_env, connectors)
    optional_monitors = parse_policy_csv(optional_env, optional_monitors)
    return HealthcheckPolicy(frozenset(connectors), frozenset(optional_monitors), profile.id)


def connector_for_service(service: str) -> str | None:
    for connector, services in CONNECTOR_SERVICE_GROUPS.items():
        if service in services:
            return connector
    return None


def optional_monitor_for_service(service: str) -> str | None:
    for monitor, services in OPTIONAL_MONITOR_SERVICE_GROUPS.items():
        if service in services:
            return monitor
    return None


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


def parse_systemd_show(output: str) -> dict[str, str]:
    props: dict[str, str] = {}
    for line in output.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        props[key.strip()] = value.strip()
    return props


def systemd_show(unit: str, *properties: str) -> dict[str, str]:
    args = ["systemctl", "show", unit]
    for prop in properties:
        args.extend(["-p", prop])
    args.append("--no-pager")
    rc, stdout, stderr = run(args, timeout=8)
    if rc != 0:
        raise RuntimeError(stderr or stdout or f"systemctl show {unit} failed")
    return parse_systemd_show(stdout)


def systemd_size_to_bytes(value: str) -> int | None:
    raw = str(value).strip()
    if not raw or raw == "infinity":
        return None
    if raw.isdigit():
        return int(raw)
    match = re.fullmatch(r"(\d+)([KMGTP])", raw, re.IGNORECASE)
    if not match:
        return None
    amount = int(match.group(1))
    power = "KMGTPE".index(match.group(2).upper()) + 1
    return amount * (1024 ** power)


def systemd_duration_to_usec(value: str) -> int | None:
    raw = str(value).strip().lower()
    if not raw or raw == "infinity":
        return None
    if raw.isdigit():
        return int(raw)
    total = 0.0
    matched = False
    for amount, unit in re.findall(r"(\d+(?:\.\d+)?)\s*(us|µs|ms|s|min|h|d)", raw):
        matched = True
        value_f = float(amount)
        if unit in {"us", "µs"}:
            total += value_f
        elif unit == "ms":
            total += value_f * 1_000
        elif unit == "s":
            total += value_f * 1_000_000
        elif unit == "min":
            total += value_f * 60 * 1_000_000
        elif unit == "h":
            total += value_f * 60 * 60 * 1_000_000
        elif unit == "d":
            total += value_f * 24 * 60 * 60 * 1_000_000
    if not matched:
        return None
    return int(total)


def cpu_quota_percent_to_usec(value: str) -> int | None:
    raw = str(value).strip()
    if not raw or not raw.endswith("%"):
        return None
    try:
        return int(float(raw[:-1]) * 10_000)
    except ValueError:
        return None


def slice_policy_enabled(slice_name: str, expected: dict[str, Any], policy: HealthcheckPolicy) -> bool:
    classification = str(expected.get("classification") or "")
    if classification == "required_core":
        return True
    if classification == "external_infra":
        return False
    connector = expected.get("connector")
    if connector:
        return str(connector) in policy.enabled_connectors
    monitors = expected.get("optional_monitors") or set()
    return bool(set(monitors) & set(policy.enabled_optional_monitors))


def systemd_slice_policy_check(
    slice_name: str,
    props: dict[str, str] | None,
    expected: dict[str, Any],
    policy: HealthcheckPolicy,
) -> Check:
    enabled = slice_policy_enabled(slice_name, expected, policy)
    if props is None:
        if enabled:
            return Check("WARN", f"slice.{slice_name}", "not configured policy=enabled", f"Install/reload {slice_name}")
        return Check("OK", f"slice.{slice_name}", "not configured policy=disabled optional")

    state = props.get("ActiveState", "unknown")
    memory_high = props.get("MemoryHigh", "")
    memory_max = props.get("MemoryMax", "")
    cpu_weight = props.get("CPUWeight", "")
    cpu_quota = props.get("CPUQuotaPerSecUSec", "")
    tasks_max = props.get("TasksMax", "")
    expected_high = systemd_size_to_bytes(str(expected.get("memory_high") or ""))
    expected_max = systemd_size_to_bytes(str(expected.get("memory_max") or ""))
    expected_cpu_quota = cpu_quota_percent_to_usec(str(expected.get("cpu_quota") or ""))
    expected_tasks_max = str(expected.get("tasks_max") or "")
    actual_high = systemd_size_to_bytes(memory_high)
    actual_max = systemd_size_to_bytes(memory_max)
    actual_cpu_quota = systemd_duration_to_usec(cpu_quota)

    violations: list[str] = []
    if expected_high is not None and actual_high != expected_high:
        violations.append(f"MemoryHigh={memory_high or 'unset'} expected={expected['memory_high']}")
    if expected_max is not None and actual_max != expected_max:
        violations.append(f"MemoryMax={memory_max or 'unset'} expected={expected['memory_max']}")
    if str(cpu_weight or "") != str(expected.get("cpu_weight")):
        violations.append(f"CPUWeight={cpu_weight or 'unset'} expected={expected.get('cpu_weight')}")
    if expected_cpu_quota is not None and actual_cpu_quota != expected_cpu_quota:
        violations.append(f"CPUQuota={cpu_quota or 'unset'} expected={expected.get('cpu_quota')}")
    if expected_tasks_max and tasks_max != expected_tasks_max:
        violations.append(f"TasksMax={tasks_max or 'unset'} expected={expected_tasks_max}")
    if expected_cpu_quota is None and actual_cpu_quota is None:
        violations.append("CPUQuota=infinity")

    detail = f"state={state} classification={expected.get('classification')} MemoryHigh={memory_high} MemoryMax={memory_max} CPUWeight={cpu_weight} CPUQuota={cpu_quota} TasksMax={tasks_max}"
    if violations:
        level = "WARN" if enabled else "OK"
        return Check(level, f"slice.{slice_name}", f"{detail} policy={'enabled' if enabled else 'disabled'} violations={'; '.join(violations)}")
    return Check("OK", f"slice.{slice_name}", f"{detail} policy={'enabled' if enabled else 'disabled'}")


def systemd_service_slice_check(service: str, props: dict[str, str] | None, expected_slice: str, policy: HealthcheckPolicy) -> Check:
    if props is None:
        connector = connector_for_service(service.removesuffix(".service"))
        optional_monitor = optional_monitor_for_service(service.removesuffix(".service"))
        managed_match = re.fullmatch(r"agent-managed@([A-Za-z0-9_.-]+)\.service", service)
        managed_agent = managed_match.group(1) if managed_match else None
        if connector and connector not in policy.enabled_connectors:
            return Check("OK", f"service_slice.{service}", f"not configured connector={connector} policy=disabled")
        if optional_monitor and optional_monitor not in policy.enabled_optional_monitors:
            return Check("OK", f"service_slice.{service}", f"not configured optional_monitor={optional_monitor} policy=disabled")
        if managed_agent and managed_agent not in policy.enabled_optional_monitors:
            return Check("OK", f"service_slice.{service}", f"not configured managed_agent={managed_agent} policy=disabled")
        return Check("WARN", f"service_slice.{service}", "not configured", f"Install/reload {service}")
    actual = props.get("Slice", "")
    if actual == expected_slice:
        return Check("OK", f"service_slice.{service}", f"Slice={actual}")
    return Check("WARN", f"service_slice.{service}", f"Slice={actual or 'unset'} expected={expected_slice}", f"Move {service} to {expected_slice}")


def expected_service_slices(policy: HealthcheckPolicy) -> dict[str, str]:
    services = dict(SYSTEMD_SERVICE_SLICES)
    for agent, expected_slice in LIFECYCLE_MANAGED_AGENT_SERVICE_SLICES.items():
        if agent in policy.enabled_optional_monitors:
            services[f"agent-managed@{agent}.service"] = expected_slice
    return services


def redis_json(*args: str) -> Any:
    rc, stdout, stderr = run(["redis-cli", "--json", *args], timeout=8)
    if rc != 0:
        raise RuntimeError(stderr or stdout or f"redis-cli {' '.join(args)} failed")
    if not stdout:
        return None
    return json.loads(stdout)


def redis_text(*args: str) -> str:
    rc, stdout, stderr = run(["redis-cli", *args], timeout=8)
    if rc != 0:
        raise RuntimeError(stderr or stdout or f"redis-cli {' '.join(args)} failed")
    return stdout


def parse_redis_commandstats(info_text: str) -> dict[str, dict[str, float]]:
    stats: dict[str, dict[str, float]] = {}
    for line in info_text.splitlines():
        line = line.strip()
        if not line.startswith("cmdstat_") or ":" not in line:
            continue
        raw_name, raw_fields = line.split(":", 1)
        command = raw_name.removeprefix("cmdstat_").lower()
        parsed: dict[str, float] = {}
        for field in raw_fields.split(","):
            if "=" not in field:
                continue
            key, value = field.split("=", 1)
            try:
                parsed[key] = float(value)
            except ValueError:
                continue
        stats[command] = parsed
    return stats


def load_redis_commandstats_snapshot(path: Path = REDIS_COMMANDSTATS_STATE_FILE) -> dict[str, Any] | None:
    try:
        if not path.exists():
            return None
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return None
        return raw
    except Exception:
        return None


def save_redis_commandstats_snapshot(stats: dict[str, dict[str, float]], now: float, path: Path = REDIS_COMMANDSTATS_STATE_FILE) -> None:
    try:
        path.write_text(json.dumps({"ts": now, "stats": stats}, sort_keys=True), encoding="utf-8")
    except Exception:
        pass


def aggregate_commandstats(stats: dict[str, dict[str, float]], command: str) -> dict[str, float]:
    """Return counters for a Redis command, including Redis 7 subcommand rows.

    Redis INFO commandstats may expose XGROUP CREATE as cmdstat_xgroup|create
    instead of rolling it into cmdstat_xgroup. Healthcheck storm detection cares
    about the whole XGROUP family, especially CREATE failed_calls.
    """
    prefix = f"{command.lower()}|"
    out: dict[str, float] = {}
    for name, counters in stats.items():
        if name != command and not name.startswith(prefix):
            continue
        for key, value in counters.items():
            out[key] = out.get(key, 0.0) + float(value or 0)
    return out


def redis_polling_storm_checks(
    current: dict[str, dict[str, float]],
    previous: dict[str, Any] | None,
    now: float,
) -> list[Check]:
    xread = aggregate_commandstats(current, "xreadgroup")
    xgroup = aggregate_commandstats(current, "xgroup")
    if not xread and not xgroup:
        return [Check("WARN", "redis.commandstats.stream_polling", "xreadgroup/xgroup stats unavailable", "Inspect: redis-cli INFO commandstats")]

    if not previous or "stats" not in previous or "ts" not in previous:
        return [Check("OK", "redis.commandstats.stream_polling", "baseline captured for XREADGROUP/XGROUP rates")]

    elapsed = max(1.0, now - float(previous.get("ts") or now))
    prev_stats = previous.get("stats") or {}
    prev_xread = aggregate_commandstats(prev_stats, "xreadgroup") if isinstance(prev_stats, dict) else {}
    prev_xgroup = aggregate_commandstats(prev_stats, "xgroup") if isinstance(prev_stats, dict) else {}

    xread_delta = max(0.0, float(xread.get("calls") or 0) - float(prev_xread.get("calls") or 0))
    xgroup_delta = max(0.0, float(xgroup.get("calls") or 0) - float(prev_xgroup.get("calls") or 0))
    xgroup_failed_delta = max(0.0, float(xgroup.get("failed_calls") or 0) - float(prev_xgroup.get("failed_calls") or 0))
    xread_rate = xread_delta / elapsed
    xgroup_rate = xgroup_delta / elapsed
    detail = (
        f"elapsed={elapsed:.0f}s xreadgroup_rate={xread_rate:.2f}/s "
        f"xgroup_rate={xgroup_rate:.2f}/s xgroup_failed_delta={int(xgroup_failed_delta)}"
    )

    if xgroup_failed_delta > 0:
        return [Check("WARN", "redis.commandstats.xgroup_failed", detail, "XGROUP CREATE failures are growing; verify group creation is outside hot poll loops")]
    if xread_rate > XREADGROUP_WARN_PER_SEC or xgroup_rate > XGROUP_WARN_PER_SEC:
        return [Check("WARN", "redis.commandstats.stream_polling", detail, "Possible Redis stream polling storm; inspect watchdogs/packers and blocking reads")]
    return [Check("OK", "redis.commandstats.stream_polling", detail)]


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


def systemd_service_check(service: str, state: str, group: str, policy: HealthcheckPolicy) -> Check:
    connector = connector_for_service(service)
    optional_monitor = optional_monitor_for_service(service)
    is_active = state == "active"
    is_unknown = state in {"unknown", "not-found", ""}

    if group == "required_core":
        if is_active:
            return Check("OK", f"service.{service}", "active classification=required_core")
        return Check("FAIL", f"service.{service}", f"{state} classification=required_core", f"Run: sudo systemctl restart {service}")

    if connector:
        enabled = connector in policy.enabled_connectors
        detail = f"{state} classification=connector_owned connector={connector} policy={'enabled' if enabled else 'disabled'}"
        if enabled:
            if is_active:
                return Check("OK", f"service.{service}", f"active classification=connector_owned connector={connector} policy=enabled")
            return Check("WARN", f"service.{service}", detail, f"Enable/start connector service only if this deployment uses {connector}")
        if is_unknown:
            return Check("OK", f"service.{service}", f"absent connector={connector} policy=disabled")
        return Check("WARN", f"service.{service}", detail, f"Disable/remove {service} or enable connector policy for {connector}")

    if optional_monitor:
        enabled = optional_monitor in policy.enabled_optional_monitors
        detail = f"{state} classification=optional_worker monitor={optional_monitor} policy={'enabled' if enabled else 'disabled'}"
        if is_active:
            level = "OK" if enabled else "WARN"
            hint = "" if enabled else f"Stop {service} or enable optional monitor policy for {optional_monitor}"
            return Check(level, f"service.{service}", detail, hint)
        return Check("OK", f"service.{service}", f"{detail} optional")

    if is_active:
        return Check("OK", f"service.{service}", f"active classification={group}")
    return Check("OK", f"service.{service}", f"{state} classification={group} optional")


def check_systemd(policy: HealthcheckPolicy | None = None) -> list[Check]:
    policy = policy or load_healthcheck_policy()
    checks: list[Check] = []
    rc, stdout, stderr = run(["systemctl", "--failed", "--no-pager"], timeout=10)
    failed_output = stdout + stderr
    if rc == 0 and "0 loaded units listed" in failed_output:
        checks.append(Check("OK", "systemd.failed", "no failed units"))
    else:
        checks.append(Check("FAIL", "systemd.failed", failed_output[:240], "Run: systemctl --failed --no-pager"))

    service_groups = [
        ("required_core", CORE_SERVICES),
        ("connector_owned", CONNECTOR_OWNED_SERVICES),
        ("optional_worker", OPTIONAL_WORKER_SERVICES),
    ]
    for group, services in service_groups:
        rc, stdout, stderr = run(["systemctl", "is-active", *services], timeout=15)
        states = stdout.splitlines()
        for service, state in zip(services, states):
            checks.append(systemd_service_check(service, state or stderr[:120], group, policy))
    return checks


def check_systemd_slices(policy: HealthcheckPolicy | None = None) -> list[Check]:
    policy = policy or load_healthcheck_policy()
    checks: list[Check] = []
    for slice_name, expected in SYSTEMD_SLICE_POLICIES.items():
        try:
            props = systemd_show(slice_name, "ActiveState", "MemoryHigh", "MemoryMax", "CPUWeight", "CPUQuotaPerSecUSec", "TasksMax")
        except Exception:
            props = None
        checks.append(systemd_slice_policy_check(slice_name, props, expected, policy))

    for service, expected_slice in expected_service_slices(policy).items():
        try:
            props = systemd_show(service, "Slice")
        except Exception:
            props = None
        checks.append(systemd_service_slice_check(service, props, expected_slice, policy))
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


def check_redis_streams(policy: HealthcheckPolicy | None = None) -> list[Check]:
    policy = policy or load_healthcheck_policy()
    checks: list[Check] = []
    try:
        if redis_json("PING") != "PONG":
            checks.append(Check("FAIL", "redis.ping", "unexpected PING response", "Run: sudo systemctl restart redis-server"))
            return checks
        checks.append(Check("OK", "redis.ping", "PONG"))
    except Exception as exc:
        return [Check("FAIL", "redis.ping", str(exc), "Run: sudo systemctl restart redis-server")]

    if "telegram" not in policy.enabled_connectors:
        checks.append(Check("OK", "redis.connector.telegram", "disabled by policy; telegram stream checks skipped"))
        return checks

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


def check_redis_polling_storm() -> list[Check]:
    now = time.time()
    try:
        stats = parse_redis_commandstats(redis_text("INFO", "commandstats"))
    except Exception as exc:
        return [Check("WARN", "redis.commandstats.stream_polling", str(exc), "Inspect: redis-cli INFO commandstats")]

    previous = load_redis_commandstats_snapshot()
    checks = redis_polling_storm_checks(stats, previous, now)
    save_redis_commandstats_snapshot(stats, now)
    return checks


def check_messenger_connector_health(policy: HealthcheckPolicy | None = None) -> list[Check]:
    policy = policy or load_healthcheck_policy()
    if "telegram" not in policy.enabled_connectors:
        return [Check("OK", "connector_health.telegram", "disabled by policy; connector health checks skipped")]
    try:
        health = api_get("/connectors/messenger/health")
    except Exception as exc:
        return [Check("WARN", "connector_health.api", str(exc), "Inspect /connectors/messenger/health and konoha.service logs")]

    checks: list[Check] = []
    for connector in health.get("connectors") or []:
        connector_id = str(connector.get("connector_id") or "unknown")
        provider = str(connector.get("provider") or "unknown")
        status = str(connector.get("status") or "warn").upper()
        checks.append(Check(
            "OK" if status == "OK" else "WARN" if status == "WARN" else "FAIL",
            f"connector.{connector_id}",
            f"provider={provider} status={status.lower()}",
        ))
        for endpoint in connector.get("endpoints") or []:
            endpoint_id = str(endpoint.get("endpoint_id") or "unknown")
            endpoint_status = str(endpoint.get("status") or "warn").upper()
            checks.append(Check(
                "OK" if endpoint_status == "OK" else "WARN" if endpoint_status == "WARN" else "FAIL",
                f"connector.{connector_id}.endpoint.{endpoint_id}",
                f"status={endpoint_status.lower()}",
            ))
            for stream in endpoint.get("streams") or []:
                stream_status = str(stream.get("status") or "warn").upper()
                stream_name = str(stream.get("stream") or "unknown")
                group = str(stream.get("group") or "unknown")
                checks.append(Check(
                    "OK" if stream_status == "OK" else "WARN" if stream_status == "WARN" else "FAIL",
                    f"connector.{connector_id}.endpoint.{endpoint_id}.stream.{stream_name}.{group}",
                    str(stream.get("detail") or f"status={stream_status.lower()}"),
                ))
    return checks or [Check("WARN", "connector_health.catalog", "no enabled connectors reported")]


def check_agents(policy: HealthcheckPolicy | None = None) -> list[Check]:
    policy = policy or load_healthcheck_policy()
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

    for agent, meta in AGENT_HEALTH_TARGETS.items():
        classification = str(meta["classification"])
        connector = CONNECTOR_AGENTS.get(agent)
        connector_enabled = connector is None or connector in policy.enabled_connectors
        profile = agent_profiles.get(agent, "unknown")
        rc, _, _ = run(["tmux", "-L", agent, "has-session", "-t", agent], timeout=5)
        if rc != 0:
            if classification == "core":
                checks.append(Check("FAIL", f"agent.{agent}.tmux", f"missing classification={classification} profile={profile}", f"Run: sudo systemctl restart agent-{agent}.service"))
            elif classification == "connector_owned" and connector_enabled:
                checks.append(Check("WARN", f"agent.{agent}.tmux", f"missing classification={classification} profile={profile}", "Start connector-owned runtime only when the connector is enabled"))
            elif classification == "connector_owned":
                checks.append(Check("OK", f"agent.{agent}.tmux", f"missing classification={classification} connector={connector} policy=disabled"))
            else:
                checks.append(Check("OK", f"agent.{agent}.tmux", f"not running classification={classification} optional"))
            continue
        rc, pane, stderr = run(["tmux", "-L", agent, "capture-pane", "-pt", agent, "-S", "-80"], timeout=5)
        if rc != 0:
            checks.append(Check("WARN", f"agent.{agent}.pane", f"{stderr[:160]} classification={classification} profile={profile}", f"Run: tmux -L {agent} capture-pane -pt {agent}"))
            continue
        signal = pane_stuck_signal(pane)
        if classification == "connector_owned" and not connector_enabled:
            checks.append(Check("WARN", f"agent.{agent}.tmux", f"running classification={classification} connector={connector} policy=disabled", f"Stop agent-{agent}.service or enable connector policy"))
        elif signal:
            checks.append(Check("WARN", f"agent.{agent}.signal", f"{signal} classification={classification} profile={profile}", f"Inspect pane; if persistent restart agent-{agent}.service"))
        else:
            checks.append(Check("OK", f"agent.{agent}.tmux", f"alive idle={str(pane_is_idle(pane)).lower()} classification={classification} profile={profile}"))
    return checks


def systemd_exec_start(service: str) -> str:
    rc, stdout, stderr = run(["systemctl", "show", service, "-p", "ExecStart", "--value"], timeout=5)
    if rc != 0:
        raise RuntimeError(stderr or stdout or f"systemctl show {service} failed")
    return stdout


def agent_policy_enabled(agent: str, classification: str, policy: HealthcheckPolicy) -> bool:
    connector = CONNECTOR_AGENTS.get(agent)
    if connector:
        return connector in policy.enabled_connectors
    if classification == "optional_worker":
        return agent in policy.enabled_optional_monitors
    return True


def watchdog_policy(service: str, policy: HealthcheckPolicy) -> tuple[bool, str]:
    if service in {"agent-watchdog-naruto.service", "agent-watchdog-sasuke.service"}:
        return "telegram" in policy.enabled_connectors, "connector=telegram"
    if service == "agent-watchdog-lifecycle.service":
        return True, "required_core"
    if service in {"agent-watchdog-kiba.service", "agent-watchdog-kakashi.service", "agent-watchdog-shikadai.service"}:
        monitor = service.removeprefix("agent-watchdog-").removesuffix(".service")
        return monitor in policy.enabled_optional_monitors, f"optional_monitor={monitor}"
    return True, "unknown"


def check_lifecycle_control_plane(policy: HealthcheckPolicy | None = None) -> list[Check]:
    policy = policy or load_healthcheck_policy()
    checks: list[Check] = []
    for agent, service in PERMANENT_AGENT_SERVICES.items():
        classification = str(AGENT_HEALTH_TARGETS.get(agent, {}).get("classification", "core"))
        enabled = agent_policy_enabled(agent, classification, policy)
        try:
            exec_start = systemd_exec_start(service)
        except Exception as exc:
            if not enabled:
                checks.append(Check("OK", f"control_plane.agent_service.{agent}", f"not configured policy=disabled classification={classification}"))
                continue
            level = "FAIL" if classification == "core" else "WARN"
            checks.append(Check(level, f"control_plane.agent_service.{agent}", f"{exc} classification={classification}", f"Inspect: systemctl cat {service}"))
            continue
        if not enabled:
            checks.append(Check("WARN", f"control_plane.agent_service.{agent}", f"configured while policy=disabled classification={classification}", f"Disable/remove {service} or enable policy"))
            continue
        expected = f"scripts/agent-api-service.sh {agent}"
        if expected in exec_start:
            checks.append(Check("OK", f"control_plane.agent_service.{agent}", f"uses lifecycle API wrapper classification={classification}"))
        else:
            level = "FAIL" if classification == "core" else "WARN"
            checks.append(Check(level, f"control_plane.agent_service.{agent}", f"{exec_start[:180]} classification={classification}", f"ExecStart should use {expected} when this runtime is enabled"))

    legacy_watchdog_users: list[str] = []
    for service, expected_script in WATCHDOG_ENTRYPOINTS.items():
        enabled, policy_detail = watchdog_policy(service, policy)
        try:
            exec_start = systemd_exec_start(service)
        except Exception as exc:
            if not enabled:
                checks.append(Check("OK", f"control_plane.watchdog.{service}", f"not configured policy=disabled {policy_detail}"))
                continue
            checks.append(Check("FAIL", f"control_plane.watchdog.{service}", str(exc), f"Inspect: systemctl cat {service}"))
            continue
        if not enabled:
            checks.append(Check("WARN", f"control_plane.watchdog.{service}", f"configured while policy=disabled {policy_detail}", f"Disable/remove {service} or enable policy"))
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


def check_disabled_experiment_agents() -> list[Check]:
    checks: list[Check] = []
    for agent, meta in DISABLED_EXPERIMENT_AGENTS.items():
        service = str(meta["service"])
        reason = str(meta["reason"])
        service_rc, service_stdout, _ = run(["systemctl", "is-active", service], timeout=5)
        tmux_rc, _, _ = run(["tmux", "-L", agent, "has-session", "-t", agent], timeout=5)
        service_state = service_stdout.strip() or ("active" if service_rc == 0 else "inactive")
        tmux_state = "active" if tmux_rc == 0 else "absent"
        detail = f"service={service_state} tmux={tmux_state} reason={reason}"
        if service_rc == 0 or tmux_rc == 0:
            checks.append(Check("WARN", f"disabled_experiment.{agent}", detail, f"Stop {service} and tmux -L {agent} kill-session -t {agent}"))
        else:
            checks.append(Check("OK", f"disabled_experiment.{agent}", detail))
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

    repo = Path(__file__).resolve().parent.parent
    rc, stdout, stderr = run(["git", "-C", str(repo), "remote", "-v"], timeout=5)
    remote_output = stdout + stderr
    if rc != 0:
        checks.append(Check("WARN", "security.git_remote_urls", remote_output[:180], "Inspect git remote -v"))
    elif re.search(r"https://[^/\s]+@", remote_output) or re.search(r"(github_pat_|ghp_|gho_|ghu_|ghs_)", remote_output):
        checks.append(Check("FAIL", "security.git_remote_urls", "credential embedded in git remote URL", "Run: git remote set-url origin https://github.com/eaprelsky/konoha.git"))
    else:
        checks.append(Check("OK", "security.git_remote_urls", "no credentials embedded in git remote URLs"))

    return checks


def check_route_auth_policy() -> list[Check]:
    script = Path(__file__).resolve().parent / "check-route-auth-policy.py"
    rc, stdout, stderr = run([sys.executable, str(script)], timeout=10)
    detail = (stdout or stderr).strip().splitlines()
    summary = detail[0] if detail else "no output"
    if rc == 0:
        return [Check("OK", "security.route_auth_policy", summary)]
    return [Check("FAIL", "security.route_auth_policy", summary[:300], f"Run: {script}")]


def check_agent_naming_policy() -> list[Check]:
    script = Path(__file__).resolve().parent / "check-agent-naming-policy.py"
    rc, stdout, stderr = run([sys.executable, str(script)], timeout=10)
    detail = (stdout or stderr).strip().splitlines()
    summary = detail[0] if detail else "no output"
    if rc == 0:
        return [Check("OK", "agent_naming.product_surface", summary)]
    return [Check("WARN", "agent_naming.product_surface", summary[:300], f"Run: {script}")]


def check_role_registry_hygiene() -> list[Check]:
    script = Path(__file__).resolve().parent / "audit-role-registry.ts"
    bun = Path(os.environ.get("BUN_BIN", "/home/ubuntu/.bun/bin/bun"))
    bun_cmd = str(bun) if bun.exists() else "bun"
    rc, stdout, stderr = run([bun_cmd, str(script), "--dry-run", "--json"], timeout=20)
    if rc != 0:
        return [Check("WARN", "role_registry.hygiene", (stderr or stdout)[:300], f"Run: {bun_cmd} {script} --dry-run")]

    try:
        summary = json.loads(stdout)
    except Exception as exc:
        return [Check("WARN", "role_registry.hygiene", f"invalid audit JSON: {exc}", f"Run: {bun_cmd} {script} --dry-run")]

    stale = len(summary.get("stale_reverse_refs") or [])
    missing_role_keys = len(summary.get("sorted_set_missing_role_key") or [])
    reverse_without_role = len(summary.get("reverse_indexes_without_role_key") or [])
    agent_like = len(summary.get("agent_like_roles") or [])
    detail = (
        f"stale_reverse_refs={stale} "
        f"sorted_set_missing_role_key={missing_role_keys} "
        f"reverse_indexes_without_role_key={reverse_without_role} "
        f"agent_like_roles={agent_like}"
    )
    if stale or missing_role_keys:
        return [Check("WARN", "role_registry.hygiene", detail, f"Run: {bun_cmd} {script} --apply to remove stale reverse refs; migrate roles manually")]
    return [Check("OK", "role_registry.hygiene", detail)]


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


def check_resource_inventory_budget() -> list[Check]:
    if not RESOURCE_INVENTORY_SCRIPT.exists():
        return [Check("WARN", "resource_inventory.report", "script missing", "Restore scripts/resource-inventory.py")]
    try:
        rc, stdout, stderr = run([sys.executable, str(RESOURCE_INVENTORY_SCRIPT), "--json", "--no-disk"], timeout=20)
    except Exception as exc:
        return [Check("WARN", "resource_inventory.report", str(exc), "Run: python3 scripts/resource-inventory.py --json")]
    if rc != 0:
        return [Check("WARN", "resource_inventory.report", (stderr or stdout)[:240], "Run: python3 scripts/resource-inventory.py")]
    try:
        report = json.loads(stdout)
    except Exception as exc:
        return [Check("WARN", "resource_inventory.report", f"invalid JSON: {exc}", "Run: python3 scripts/resource-inventory.py --json --no-disk")]

    groups = report.get("groups") or {}
    pressure = {
        name: group.get("budget_pressure")
        for name, group in groups.items()
        if group.get("budget_pressure") in {"warning", "critical"}
    }
    total_rss_kib = sum(int(group.get("rss_kib") or 0) for group in groups.values())
    detail = f"groups={len(groups)} total_rss_kib={total_rss_kib} pressure={pressure or 'none'}"
    if any(level == "critical" for level in pressure.values()):
        return [Check("WARN", "resource_inventory.budget_pressure", detail, "Inspect: python3 scripts/resource-inventory.py")]
    if pressure:
        return [Check("WARN", "resource_inventory.budget_pressure", detail, "Inspect: python3 scripts/resource-inventory.py")]
    return [Check("OK", "resource_inventory.budget_pressure", detail)]


def main() -> int:
    load_env_defaults()
    if "--policy-dry-run" in sys.argv:
        policy = load_healthcheck_policy()
        print(json.dumps(policy.as_dict(), ensure_ascii=False, indent=2))
        return 0
    policy = load_healthcheck_policy()
    checks: list[Check] = []
    checks.extend(check_systemd(policy))
    checks.extend(check_systemd_slices(policy))
    checks.extend(check_api())
    checks.extend(check_redis_streams(policy))
    checks.extend(check_redis_polling_storm())
    checks.extend(check_messenger_connector_health(policy))
    checks.extend(check_agents(policy))
    checks.extend(check_lifecycle_control_plane(policy))
    checks.extend(check_disabled_experiment_agents())
    for fn in (check_shared_config, check_security_hygiene, check_route_auth_policy, check_agent_naming_policy, check_role_registry_hygiene, check_workflow_engine, check_codex_proxy, check_agent_registry_hygiene, check_agent_definition_storage_split, check_llm_client_profiles, check_large_source_files, check_resource_inventory_budget):
        checks.extend(fn())
    return print_report(checks)


if __name__ == "__main__":
    raise SystemExit(main())
