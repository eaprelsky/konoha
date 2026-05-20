#!/usr/bin/env python3
"""Live Konoha resource inventory with redacted process origins.

The report is intentionally process-table based: it can run during incidents
without Redis/API dependencies and still maps managed agents, MCP children,
connectors, TestBench, Docker/mail, and cache/artifact disk usage.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from resource_budgets import disk_budget_kib_by_name, expected_memory_max_kib, systemd_budget_units

DEFAULT_TOP = 12
KIB = 1024
MIB = 1024 * 1024

SYSTEMD_BUDGET_UNITS = systemd_budget_units()
EXPECTED_MEMORY_MAX_KIB = expected_memory_max_kib()
DISK_BUDGET_KIB = disk_budget_kib_by_name()

CACHE_TARGETS = [
    ("npm_npx_cache", Path("/home/ubuntu/.npm/_npx")),
    ("npm_cache", Path("/home/ubuntu/.npm")),
    ("uv_cache", Path("/home/ubuntu/.cache/uv")),
    ("bun_cache", Path("/home/ubuntu/.bun/install/cache")),
    ("playwright_cache", Path("/home/ubuntu/.cache/ms-playwright")),
    ("repo_node_modules", REPO_ROOT / "node_modules"),
    ("template_node_modules", Path("/opt/shared/comind-template/node_modules")),
]

MCP_PATTERNS: list[tuple[str, str]] = [
    ("konoha", r"(^|\s)(/home/ubuntu/\.bun/bin/)?bun\s+run\s+/home/ubuntu/konoha/src/mcp\.ts"),
    ("telethon-channel", r"telethon-mcp/channel-server\.ts"),
    ("bitrix24", r"bitrix24-mcp-server"),
    ("gitlab", r"mcp-gitlab|@zereight/mcp-gitlab"),
    ("yonote", r"yonote-mcp"),
    ("yandex-tracker", r"yandex-tracker-mcp"),
    ("memory", r"server-memory|mcp-server-memory"),
    ("mempalace", r"mempalace\.mcp_server"),
    ("puppeteer", r"server-puppeteer|mcp-server-puppeteer"),
    ("caldav", r"caldav-mcp|mcp-caldav"),
    ("openrouter-audio", r"openrouter-audio-mcp"),
    ("miro-api", r"miro-api-mcp"),
    ("miro", r"mcp\.miro\.com"),
    ("excel", r"excel-mcp-server"),
    ("word", r"word_mcp_server|office-word-mcp-server"),
    ("google-sheets", r"mcp-google-sheets"),
    ("google-docs", r"google-docs-mcp"),
    ("email", r"mcp-email-server"),
    ("sequential-thinking", r"server-sequential-thinking|mcp-server-sequential-thinking"),
    ("filesystem", r"server-filesystem|mcp-server-filesystem"),
]

SENSITIVE_REPLACEMENTS = [
    (re.compile(r"(?i)(authorization:\s*bearer\s+)[^\s'\"]+"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\b([a-z0-9_]*(?:token|secret|password|api_key|webhook)[a-z0-9_]*=)([^\s'\"]+)"), r"\1[REDACTED]"),
    (re.compile(r"(?i)([?&](?:token|key|secret|password|webhook)=)[^&\s'\"]+"), r"\1[REDACTED]"),
    (re.compile(r"\b[A-Fa-f0-9]{48,}\b"), "[REDACTED_HEX]"),
]


@dataclass
class ProcessRow:
    pid: int
    ppid: int
    rss_kib: int
    cpu_percent: float
    command: str
    args: str
    redacted_args: str
    group: str = "other"
    agent_id: str | None = None
    mcp_server: str | None = None
    systemd_unit: str | None = None
    systemd_slice: str | None = None


@dataclass
class GroupSummary:
    group: str
    process_count: int = 0
    rss_kib: int = 0
    cpu_percent: float = 0.0
    peak_rss_kib: int | None = None
    budget_max_kib: int | None = None
    budget_pressure: str = "unknown"
    members: list[str] = field(default_factory=list)


def run(cmd: list[str], timeout: int = 10) -> tuple[int, str, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def redact(value: str) -> str:
    redacted = value
    for pattern, replacement in SENSITIVE_REPLACEMENTS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def parse_ps(output: str) -> list[ProcessRow]:
    rows: list[ProcessRow] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        parts = line.strip().split(None, 4)
        if len(parts) < 5:
            continue
        pid_s, ppid_s, rss_s, cpu_s, rest = parts
        command, _, args = rest.partition(" ")
        try:
            rows.append(ProcessRow(
                pid=int(pid_s),
                ppid=int(ppid_s),
                rss_kib=int(float(rss_s)),
                cpu_percent=float(cpu_s),
                command=command,
                args=args or command,
                redacted_args=redact(args or command),
            ))
        except ValueError:
            continue
    return rows


def collect_processes() -> list[ProcessRow]:
    rc, stdout, stderr = run(["ps", "-eo", "pid=,ppid=,rss=,pcpu=,comm=,args="], timeout=10)
    if rc != 0:
        raise RuntimeError(stderr or "ps failed")
    rows = parse_ps(stdout)
    classify_processes(rows)
    return rows


def read_proc_cgroup(pid: int) -> tuple[str | None, str | None]:
    try:
        text = Path(f"/proc/{pid}/cgroup").read_text(encoding="utf-8")
    except OSError:
        return None, None
    unit = None
    slice_name = None
    for line in text.splitlines():
        _, _, path = line.partition(":")
        path = path.split(":", 1)[-1]
        for part in path.split("/"):
            clean = part.replace("\\x2d", "-")
            if clean.endswith(".slice"):
                slice_name = clean
            if clean.endswith((".service", ".scope")):
                unit = clean
    return unit, slice_name


def infer_agent_from_args(args: str) -> str | None:
    patterns = [
        r"/opt/shared/agent-workdirs/([^/\s'\"]+)",
        r"/agent-workdirs/([^/\s'\"]+)/\.mcp\.json",
        r"tmux\s+-L\s+([^ \t'\"]+)",
        r"--unit=konoha-agent-([^ \t'\"]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, args)
        if match:
            value = match.group(1).removesuffix(".scope")
            if value.startswith("$") or value in {"$a", "${a}"}:
                continue
            return value
    return None


def infer_mcp_server(args: str) -> str | None:
    for name, pattern in MCP_PATTERNS:
        if re.search(pattern, args, re.IGNORECASE):
            return name
    return None


def infer_group(row: ProcessRow) -> str:
    args = row.args.lower()
    unit = (row.systemd_unit or "").lower()
    if row.mcp_server:
        return "mcp_server"
    if "konoha-testbench" in args or "playwright" in args or "chrome-headless" in args or "chromium" in args:
        return "testbench_browser"
    if any(token in unit or token in args for token in ["telegram-bot", "telegram-bus", "telegram-context-packer", "telegram-event-bridge", "telegram-vision-packer"]):
        return "telegram_connector"
    if any(token in args for token in ["docker", "containerd", "postfix", "dovecot", "mailpit", "smtp"]):
        return "docker_mail_stack"
    if row.agent_id and any(token in args for token in ["tmux", "claude", "codex", "cursor-agent", "run-claude-agent.sh"]):
        return "managed_agent"
    if "konoha.service" in unit or "/konoha/src/server" in args or "bun run src/server" in args:
        return "core_konoha_api"
    if "/home/ubuntu/konoha/" in args or "/opt/shared/agent-workdirs/" in args:
        return "other_konoha"
    return "other"


def classify_processes(rows: list[ProcessRow]) -> None:
    by_pid = {row.pid: row for row in rows}
    for row in rows:
        row.systemd_unit, row.systemd_slice = read_proc_cgroup(row.pid)
        row.agent_id = infer_agent_from_args(row.args)
        row.mcp_server = infer_mcp_server(row.args)

    for row in rows:
        if row.agent_id:
            continue
        parent = by_pid.get(row.ppid)
        hops = 0
        while parent and hops < 12:
            if parent.agent_id:
                row.agent_id = parent.agent_id
                break
            parent = by_pid.get(parent.ppid)
            hops += 1

    for row in rows:
        row.group = infer_group(row)


def systemd_size_to_kib(value: str | None) -> int | None:
    raw = str(value or "").strip()
    if not raw or raw == "infinity":
        return None
    if raw.isdigit():
        return int(raw) // KIB
    match = re.fullmatch(r"(\d+)([KMGTP])", raw, re.IGNORECASE)
    if not match:
        return None
    amount = int(match.group(1))
    power = "KMGTPE".index(match.group(2).upper()) + 1
    return amount * (1024 ** power) // KIB


def collect_systemd_budget() -> dict[str, dict[str, str]]:
    budget: dict[str, dict[str, str]] = {}
    for unit in SYSTEMD_BUDGET_UNITS:
        rc, stdout, _ = run([
            "systemctl",
            "show",
            unit,
            "-p", "ActiveState",
            "-p", "MemoryCurrent",
            "-p", "MemoryPeak",
            "-p", "MemoryHigh",
            "-p", "MemoryMax",
            "-p", "CPUUsageNSec",
            "-p", "CPUQuotaPerSecUSec",
            "-p", "Result",
            "-p", "NRestarts",
            "-p", "OOMKilled",
            "--no-pager",
        ], timeout=4)
        if rc != 0:
            continue
        props: dict[str, str] = {}
        for line in stdout.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                props[key] = value
        budget[unit] = props
    return budget


def summarize(rows: list[ProcessRow], budget: dict[str, dict[str, str]]) -> dict[str, GroupSummary]:
    summaries: dict[str, GroupSummary] = {}
    for row in rows:
        summary = summaries.setdefault(row.group, GroupSummary(group=row.group))
        summary.process_count += 1
        summary.rss_kib += row.rss_kib
        summary.cpu_percent += row.cpu_percent
        if row.agent_id:
            label = f"agent:{row.agent_id}"
        elif row.mcp_server:
            label = f"mcp:{row.mcp_server}"
        elif row.systemd_unit:
            label = row.systemd_unit
        else:
            label = row.command
        if label not in summary.members:
            summary.members.append(label)

    by_unit_rss: dict[str, int] = {}
    by_unit_group: dict[str, str] = {}
    for row in rows:
        if not row.systemd_unit:
            continue
        by_unit_rss[row.systemd_unit] = by_unit_rss.get(row.systemd_unit, 0) + row.rss_kib
        by_unit_group.setdefault(row.systemd_unit, row.group)

    for unit, props in budget.items():
        group = by_unit_group.get(unit)
        if not group:
            if unit.endswith(".slice"):
                group = "systemd_slice"
            elif "telegram" in unit:
                group = "telegram_connector"
            elif "testbench" in unit:
                group = "testbench_browser"
            elif unit == "konoha.service":
                group = "core_konoha_api"
            else:
                continue
        summary = summaries.setdefault(group, GroupSummary(group=group))
        current_kib = systemd_size_to_kib(props.get("MemoryCurrent"))
        max_kib = systemd_size_to_kib(props.get("MemoryMax")) or EXPECTED_MEMORY_MAX_KIB.get(unit)
        peak_kib = systemd_size_to_kib(props.get("MemoryPeak"))
        if current_kib:
            summary.rss_kib = max(summary.rss_kib, current_kib)
        if max_kib:
            summary.budget_max_kib = max(summary.budget_max_kib or 0, max_kib)
        if peak_kib:
            summary.peak_rss_kib = max(summary.peak_rss_kib or 0, peak_kib)

    for summary in summaries.values():
        basis = summary.peak_rss_kib or summary.rss_kib
        if not summary.budget_max_kib:
            summary.budget_pressure = "unknown"
        else:
            ratio = basis / summary.budget_max_kib
            if ratio >= 0.9:
                summary.budget_pressure = "critical"
            elif ratio >= 0.75:
                summary.budget_pressure = "warning"
            else:
                summary.budget_pressure = "ok"
        summary.members = sorted(summary.members)[:16]
    return dict(sorted(summaries.items()))


def pressure_for(current_kib: int | None, peak_kib: int | None, max_kib: int | None) -> str:
    if not max_kib:
        return "unknown"
    basis = peak_kib or current_kib or 0
    ratio = basis / max_kib
    if ratio >= 0.9:
        return "critical"
    if ratio >= 0.75:
        return "warning"
    return "ok"


def summarize_service_budgets(budget: dict[str, dict[str, str]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for unit, props in sorted(budget.items()):
        current_kib = systemd_size_to_kib(props.get("MemoryCurrent"))
        peak_kib = systemd_size_to_kib(props.get("MemoryPeak"))
        actual_max_kib = systemd_size_to_kib(props.get("MemoryMax"))
        max_kib = actual_max_kib or EXPECTED_MEMORY_MAX_KIB.get(unit)
        rows.append({
            "unit": unit,
            "active_state": props.get("ActiveState") or "unknown",
            "memory_current_kib": current_kib,
            "memory_peak_kib": peak_kib,
            "memory_max_kib": max_kib,
            "memory_actual_max_kib": actual_max_kib,
            "memory_limit_hit": bool(actual_max_kib and peak_kib and peak_kib >= actual_max_kib),
            "cpu_usage_nsec": int(props.get("CPUUsageNSec") or 0) if str(props.get("CPUUsageNSec") or "").isdigit() else None,
            "cpu_quota": props.get("CPUQuotaPerSecUSec") or "",
            "result": props.get("Result") or "",
            "n_restarts": int(props.get("NRestarts") or 0) if str(props.get("NRestarts") or "").isdigit() else 0,
            "oom_killed": str(props.get("OOMKilled") or "").lower() in {"yes", "true", "1"},
            "budget_pressure": pressure_for(current_kib, peak_kib, max_kib),
        })
    return rows


def du_kib(path: Path) -> int | None:
    if not path.exists():
        return None
    try:
        rc, stdout, _ = run(["du", "-sk", str(path)], timeout=15)
    except subprocess.TimeoutExpired:
        return None
    if rc != 0 or not stdout:
        return None
    try:
        return int(stdout.split()[0])
    except (ValueError, IndexError):
        return None


def collect_disk_inventory() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for name, path in CACHE_TARGETS:
        budget_kib = DISK_BUDGET_KIB.get(name)
        size = du_kib(path)
        if size is None:
            if path.exists():
                entries.append({
                    "name": name,
                    "path": str(path),
                    "size_kib": None,
                    "budget_kib": budget_kib,
                    "budget_pressure": "unknown",
                    "status": "unavailable_or_timeout",
                })
            continue
        entries.append({
            "name": name,
            "path": str(path),
            "size_kib": size,
            "budget_kib": budget_kib,
            "budget_pressure": pressure_for(size, None, budget_kib),
            "status": "ok",
        })
    return sorted(entries, key=lambda item: item["size_kib"] or -1, reverse=True)


def serialize_process(row: ProcessRow) -> dict[str, Any]:
    data = asdict(row)
    data.pop("args", None)
    return data


def build_report(include_disk: bool = True) -> dict[str, Any]:
    rows = collect_processes()
    budget = collect_systemd_budget()
    summaries = summarize(rows, budget)
    top_processes = sorted(rows, key=lambda row: row.rss_kib, reverse=True)[:DEFAULT_TOP]
    return {
        "schema_version": 1,
        "generated_at": subprocess.check_output(["date", "-Iseconds"], text=True).strip(),
        "groups": {name: asdict(summary) for name, summary in summaries.items()},
        "service_budgets": summarize_service_budgets(budget),
        "top_processes": [serialize_process(row) for row in top_processes],
        "mcp_processes": [serialize_process(row) for row in rows if row.group == "mcp_server"],
        "disk": collect_disk_inventory() if include_disk else [],
        "notes": [
            "args are redacted before output",
            "peak_rss_kib is populated from systemd MemoryPeak where available",
            "agent_id and mcp_server are inferred from workdir, .mcp.json, process tree, and known MCP command patterns",
        ],
    }


def format_kib(value: int | None) -> str:
    if value is None:
        return "n/a"
    if value >= 1024 * 1024:
        return f"{value / (1024 * 1024):.2f} GiB"
    if value >= 1024:
        return f"{value / 1024:.1f} MiB"
    return f"{value} KiB"


def format_text(report: dict[str, Any]) -> str:
    lines = ["Konoha Resource Inventory", ""]
    lines.append("Groups:")
    lines.append("group processes rss cpu peak budget pressure members")
    for name, raw in report["groups"].items():
        members = ",".join(raw.get("members", [])[:6])
        lines.append(
            f"{name} {raw['process_count']} {format_kib(raw['rss_kib'])} "
            f"{raw['cpu_percent']:.1f}% {format_kib(raw.get('peak_rss_kib'))} "
            f"{format_kib(raw.get('budget_max_kib'))} {raw['budget_pressure']} {members}"
        )

    lines.extend(["", "Top RSS processes:"])
    for row in report["top_processes"]:
        origin = row.get("mcp_server") or row.get("agent_id") or row.get("systemd_unit") or row.get("group")
        lines.append(f"{row['pid']} {format_kib(row['rss_kib'])} cpu={row['cpu_percent']:.1f}% group={row['group']} origin={origin} args={row['redacted_args'][:180]}")

    if report.get("disk"):
        lines.extend(["", "Cache/artifact disk usage:"])
        for entry in report["disk"]:
            status = entry.get("status", "ok")
            lines.append(
                f"{entry['name']} {format_kib(entry['size_kib'])} budget={format_kib(entry.get('budget_kib'))} "
                f"pressure={entry.get('budget_pressure', 'unknown')} status={status} {entry['path']}"
            )
    if report.get("service_budgets"):
        lines.extend(["", "Service budgets:"])
        for entry in report["service_budgets"]:
            lines.append(
                f"{entry['unit']} state={entry['active_state']} current={format_kib(entry['memory_current_kib'])} "
                f"peak={format_kib(entry['memory_peak_kib'])} max={format_kib(entry['memory_max_kib'])} "
                f"actual_max={format_kib(entry.get('memory_actual_max_kib'))} "
                f"pressure={entry['budget_pressure']} limit_hit={entry.get('memory_limit_hit', False)} "
                f"result={entry.get('result', '') or 'n/a'} restarts={entry.get('n_restarts', 0)} oom={entry.get('oom_killed', False)}"
            )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build live Konoha resource inventory")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    parser.add_argument("--no-disk", action="store_true", help="skip cache/artifact du scan")
    args = parser.parse_args()

    report = build_report(include_disk=not args.no_disk)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(format_text(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
