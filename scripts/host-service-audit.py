#!/usr/bin/env python3
"""Audit optional non-Konoha host services and print safe disable actions."""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from resource_budgets import host_service_audit, host_service_disable_candidates, protected_host_service_units


CRITICAL_UNIT_PATTERNS = (
    "konoha",
    "telegram",
    "docker",
    "containerd",
    "postfix",
    "dovecot",
    "rspamd",
    "ssh",
    "redis",
    "postgres",
    "nginx",
)


@dataclass
class UnitState:
    unit: str
    active: str
    enabled: str


@dataclass
class CandidatePlan:
    id: str
    classification: str
    precondition: str
    units: list[str]
    states: list[UnitState]
    disable_commands: list[str]
    rollback_commands: list[str]
    expected_savings_mib: int
    status: str


def run(cmd: list[str], timeout: int = 10) -> tuple[int, str, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def systemctl_state(unit: str) -> UnitState:
    active_rc, active, _ = run(["systemctl", "is-active", unit], timeout=5)
    enabled_rc, enabled, _ = run(["systemctl", "is-enabled", unit], timeout=5)
    return UnitState(
        unit=unit,
        active=active if active_rc == 0 else (active or "inactive"),
        enabled=enabled if enabled_rc == 0 else (enabled or "disabled"),
    )


def protected_match(unit: str, protected_units: set[str]) -> bool:
    if unit in protected_units:
        return True
    lowered = unit.lower()
    return any(pattern in lowered for pattern in CRITICAL_UNIT_PATTERNS)


def validate_candidates(candidates: dict[str, dict[str, Any]], protected_units: set[str]) -> None:
    violations = []
    for candidate in candidates.values():
        for unit in candidate.get("units", []):
            if protected_match(unit, protected_units):
                violations.append(f"{candidate['id']}->{unit}")
    if violations:
        joined = ", ".join(sorted(violations))
        raise ValueError(f"disable candidate touches protected unit(s): {joined}")


def build_plan(candidate_ids: list[str] | None = None) -> list[CandidatePlan]:
    audit = host_service_audit()
    candidates = host_service_disable_candidates()
    protected_units = protected_host_service_units()
    validate_candidates(candidates, protected_units)

    selected = candidate_ids or list(candidates)
    missing = sorted(set(selected) - set(candidates))
    if missing:
        raise ValueError(f"unknown host service disable candidate(s): {', '.join(missing)}")

    plans: list[CandidatePlan] = []
    for candidate_id in selected:
        candidate = candidates[candidate_id]
        states = [systemctl_state(unit) for unit in candidate["units"]]
        active = any(state.active == "active" or state.enabled == "enabled" for state in states)
        plans.append(CandidatePlan(
            id=candidate_id,
            classification=candidate["classification"],
            precondition=candidate["precondition"],
            units=list(candidate["units"]),
            states=states,
            disable_commands=list(candidate["disable_commands"]),
            rollback_commands=list(candidate["rollback_commands"]),
            expected_savings_mib=int(candidate.get("expected_savings_mib", 0)),
            status="actionable" if active else "already_disabled_or_absent",
        ))

    if not audit.get("scope_guard"):
        raise ValueError("host service audit must define scope_guard")
    return plans


def execute_commands(commands: list[str], *, use_sudo: bool) -> list[dict[str, Any]]:
    results = []
    for command in commands:
        argv = shlex.split(command)
        if use_sudo and argv[:1] == ["systemctl"]:
            argv = ["sudo", "-n", *argv]
        rc, stdout, stderr = run(argv, timeout=30)
        results.append({"command": command, "returncode": rc, "stdout": stdout, "stderr": stderr})
        if rc != 0:
            break
    return results


def render_text(plans: list[CandidatePlan], *, apply: bool) -> str:
    mode = "APPLY" if apply else "DRY-RUN"
    lines = [f"Host service audit mode={mode}"]
    for plan in plans:
        lines.append("")
        lines.append(f"{plan.id}: {plan.status}, savings~{plan.expected_savings_mib}MiB")
        lines.append(f"  precondition: {plan.precondition}")
        for state in plan.states:
            lines.append(f"  unit: {state.unit} active={state.active} enabled={state.enabled}")
        lines.append("  disable:")
        for command in plan.disable_commands:
            lines.append(f"    sudo {command}")
        lines.append("  rollback:")
        for command in plan.rollback_commands:
            lines.append(f"    sudo {command}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", action="append", help="Candidate id to include; repeatable.")
    parser.add_argument("--apply", action="store_true", help="Run disable commands. Default is dry-run.")
    parser.add_argument("--sudo", action="store_true", help="Use sudo -n when applying systemctl commands.")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text.")
    args = parser.parse_args(argv)

    try:
        plans = build_plan(args.candidate)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    applied: list[dict[str, Any]] = []
    if args.apply:
        for plan in plans:
            if plan.status == "actionable":
                applied.extend(execute_commands(plan.disable_commands, use_sudo=args.sudo))

    if args.json:
        print(json.dumps({
            "mode": "apply" if args.apply else "dry-run",
            "plans": [asdict(plan) for plan in plans],
            "applied": applied,
        }, indent=2, sort_keys=True))
    else:
        print(render_text(plans, apply=args.apply))
        if applied:
            print("")
            print("Applied:")
            for result in applied:
                print(f"  {result['command']} rc={result['returncode']}")
    return 0 if not any(result.get("returncode") for result in applied) else 1


if __name__ == "__main__":
    raise SystemExit(main())
