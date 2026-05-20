#!/usr/bin/env python3
"""Dry-run/apply cleanup for allowlisted disk cache retention targets."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from resource_budgets import disk_budget_entries


@dataclass
class CleanupCandidate:
    target: str
    path: str
    size_kib: int
    reason: str
    action: str


@dataclass
class CleanupResult:
    mode: str
    candidates: list[CleanupCandidate]
    skipped: list[dict[str, Any]]
    reclaimed_kib: int


def run(cmd: list[str], timeout: int = 10) -> tuple[int, str, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def du_kib(path: Path) -> int:
    rc, stdout, _ = run(["du", "-sk", str(path)], timeout=15)
    if rc != 0 or not stdout:
        return 0
    try:
        return int(stdout.split()[0])
    except (ValueError, IndexError):
        return 0


def active_process_args() -> str:
    rc, stdout, _ = run(["ps", "-eo", "args="], timeout=10)
    return stdout if rc == 0 else ""


def is_referenced(path: Path, process_args: str) -> bool:
    return str(path) in process_args


def stale_child_dirs(target: str, budget: dict[str, Any], *, now: float | None = None) -> tuple[list[CleanupCandidate], list[dict[str, Any]]]:
    cleanup = budget.get("cleanup") or {}
    if cleanup.get("mode") != "delete_stale_children" or cleanup.get("automated") is not True:
        return [], [{"target": target, "reason": "not_automated_delete_stale_children"}]

    root = Path(str(budget["path"]))
    if not root.exists():
        return [], [{"target": target, "path": str(root), "reason": "path_absent"}]
    if not root.is_dir():
        return [], [{"target": target, "path": str(root), "reason": "not_directory"}]

    retention_days = int(budget.get("retention_days") or 7)
    cutoff = (now or time.time()) - retention_days * 86400
    process_args = active_process_args() if cleanup.get("never_delete_active_refs") else ""
    candidates: list[CleanupCandidate] = []
    skipped: list[dict[str, Any]] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            skipped.append({"target": target, "path": str(child), "reason": "not_directory"})
            continue
        if child.stat().st_mtime >= cutoff:
            skipped.append({"target": target, "path": str(child), "reason": "younger_than_retention"})
            continue
        if process_args and is_referenced(child, process_args):
            skipped.append({"target": target, "path": str(child), "reason": "active_process_reference"})
            continue
        candidates.append(CleanupCandidate(
            target=target,
            path=str(child),
            size_kib=du_kib(child),
            reason=f"older_than_{retention_days}d",
            action="delete_directory",
        ))
    return candidates, skipped


def build_plan(targets: list[str] | None = None) -> CleanupResult:
    budgets = disk_budget_entries()
    selected = targets or [name for name, budget in budgets.items() if (budget.get("cleanup") or {}).get("automated") is True]
    missing = sorted(set(selected) - set(budgets))
    if missing:
        raise ValueError(f"unknown cleanup target(s): {', '.join(missing)}")

    candidates: list[CleanupCandidate] = []
    skipped: list[dict[str, Any]] = []
    for target in selected:
        target_candidates, target_skipped = stale_child_dirs(target, budgets[target])
        candidates.extend(target_candidates)
        skipped.extend(target_skipped)
    return CleanupResult(mode="dry-run", candidates=candidates, skipped=skipped, reclaimed_kib=0)


def apply_plan(plan: CleanupResult) -> CleanupResult:
    reclaimed = 0
    skipped = list(plan.skipped)
    for candidate in plan.candidates:
        path = Path(candidate.path)
        before = du_kib(path)
        if path.exists():
            shutil.rmtree(path)
        reclaimed += before
    return CleanupResult(mode="apply", candidates=plan.candidates, skipped=skipped, reclaimed_kib=reclaimed)


def render_text(result: CleanupResult) -> str:
    lines = [f"Cache retention cleanup mode={result.mode} candidates={len(result.candidates)} reclaimed_kib={result.reclaimed_kib}"]
    for candidate in result.candidates:
        lines.append(f"DELETE {candidate.path} size_kib={candidate.size_kib} reason={candidate.reason}")
    if result.skipped:
        lines.append("Skipped:")
        for row in result.skipped[:24]:
            suffix = f" path={row.get('path')}" if row.get("path") else ""
            lines.append(f"  {row.get('target')} reason={row.get('reason')}{suffix}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", action="append", help="Cleanup target from docs/resource-budgets.json; repeatable.")
    parser.add_argument("--apply", action="store_true", help="Delete allowlisted stale cache entries. Default is dry-run.")
    parser.add_argument("--json", action="store_true", help="Emit JSON.")
    args = parser.parse_args(argv)

    try:
        plan = build_plan(args.target)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    result = apply_plan(plan) if args.apply else plan
    if args.json:
        print(json.dumps(asdict(result), indent=2, sort_keys=True))
    else:
        print(render_text(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
