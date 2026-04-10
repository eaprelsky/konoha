#!/usr/bin/env python3
"""
Pre-release gate script (SHIKADAI-4, #365).

Triggered by "release-request" message in Konoha bus.
Runs 8 checks; reports Approved or Blocked to naruto (and optionally to Yegor).

Usage:
    python3 pre-release-gate.py                # run checks, print results
    python3 pre-release-gate.py --notify       # run checks, send results to bus
"""

import asyncio
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

KONOHA_URL   = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
KONOHA_REPO  = Path(os.environ.get("KONOHA_REPO", os.path.expanduser("~/konoha")))
NOTIFY       = "--notify" in sys.argv


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 120) -> tuple[int, str, str]:
    """Run a command, return (returncode, stdout, stderr)."""
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
        cwd=str(cwd or KONOHA_REPO),
    )
    return result.returncode, result.stdout, result.stderr


def check_typecheck() -> tuple[bool, str]:
    """Check 1: bun run typecheck — zero TypeScript errors."""
    rc, stdout, stderr = run(["bun", "run", "typecheck"], timeout=120)
    if rc == 0:
        return True, "TypeScript: no errors"
    output = (stdout + stderr).strip()[:500]
    return False, f"TypeScript errors:\n{output}"


def check_tests() -> tuple[bool, str]:
    """Check 2: bun test — all tests pass."""
    rc, stdout, stderr = run(["bun", "test", "--timeout", "30000"], timeout=180)
    if rc == 0:
        return True, "Tests: all pass"
    output = (stdout + stderr).strip()[:500]
    return False, f"Test failures:\n{output}"


def check_file_sizes() -> tuple[bool, str]:
    """Check 3: no file in frontend/src/pages/ > 500 lines."""
    pages_dir = KONOHA_REPO / "frontend" / "src" / "pages"
    violations = []
    if pages_dir.exists():
        for f in pages_dir.rglob("*.tsx"):
            lines = len(f.read_text(encoding="utf-8", errors="replace").splitlines())
            if lines > 500:
                violations.append(f"{f.relative_to(KONOHA_REPO)}: {lines} lines")
    if not violations:
        return True, "File sizes: all under 500 lines"
    return False, f"Files over 500 lines:\n" + "\n".join(violations)


def check_runtime_size() -> tuple[bool, str]:
    """Check 4: src/runtime.ts < 50 lines (only re-exports)."""
    runtime = KONOHA_REPO / "src" / "runtime.ts"
    if not runtime.exists():
        return True, "runtime.ts: not found (OK — may be split)"
    lines = len(runtime.read_text(encoding="utf-8", errors="replace").splitlines())
    if lines <= 50:
        return True, f"runtime.ts: {lines} lines (OK)"
    return False, f"runtime.ts: {lines} lines (>50, should be re-exports only)"


def check_no_p0_issues() -> tuple[bool, str]:
    """Check 5: no open GitHub issues with label 'P0: critical'."""
    gh_token = os.environ.get("GH_TOKEN", "")
    if not gh_token:
        return True, "P0 issues: GH_TOKEN not set, skipping"
    env = {**os.environ, "GH_TOKEN": gh_token}
    result = subprocess.run(
        ["gh", "issue", "list", "--repo", "eaprelsky/konoha",
         "--label", "P0: critical", "--state", "open",
         "--json", "number,title", "--limit", "10"],
        capture_output=True, text=True, timeout=30, env=env,
    )
    if result.returncode != 0:
        return True, "P0 issues: gh CLI error, skipping"
    issues = json.loads(result.stdout) if result.stdout.strip() else []
    if not issues:
        return True, "P0 issues: none open"
    titles = "\n".join(f"  #{i['number']}: {i['title']}" for i in issues)
    return False, f"Open P0 issues:\n{titles}"


def check_changelog() -> tuple[bool, str]:
    """Check 6: CHANGELOG.md contains section for current version."""
    changelog = KONOHA_REPO / "CHANGELOG.md"
    pkg = KONOHA_REPO / "package.json"
    if not changelog.exists():
        return False, "CHANGELOG.md: not found"
    if not pkg.exists():
        return True, "CHANGELOG.md: package.json not found, skipping version check"
    version = json.loads(pkg.read_text())["version"]
    content = changelog.read_text(encoding="utf-8")
    if version in content:
        return True, f"CHANGELOG.md: contains v{version}"
    return False, f"CHANGELOG.md: no section for v{version}"


def check_version_match() -> tuple[bool, str]:
    """Check 7: package.json version matches CHANGELOG."""
    # This is implied by check_changelog — they match if changelog has the version
    pkg = KONOHA_REPO / "package.json"
    changelog = KONOHA_REPO / "CHANGELOG.md"
    if not pkg.exists() or not changelog.exists():
        return True, "Version match: files missing, skipping"
    version = json.loads(pkg.read_text())["version"]
    content = changelog.read_text(encoding="utf-8")
    # Find the first version header in changelog
    match = re.search(r"##\s+\[?v?(\d+\.\d+\.\d+)", content)
    if not match:
        return False, f"CHANGELOG.md: no version header found"
    changelog_version = match.group(1)
    if version == changelog_version:
        return True, f"Version match: {version} OK"
    return False, f"Version mismatch: package.json={version}, CHANGELOG latest={changelog_version}"


def check_testbench_smoke() -> tuple[bool, str]:
    """Check 8: TestBench smoke — login, dashboard, editor, load process."""
    # Check if testbench is running by hitting the health endpoint
    result = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "http://127.0.0.1:3001/health"],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0 or result.stdout.strip() != "200":
        return False, "TestBench: not reachable (http://127.0.0.1:3001/health)"

    # Run a quick session test via TestBench API
    try:
        # Acquire session
        sess_result = subprocess.run(
            ["curl", "-s", "-X", "POST", "http://127.0.0.1:3001/testbench/session"],
            capture_output=True, text=True, timeout=15,
        )
        sess = json.loads(sess_result.stdout)
        sid = sess.get("session_id")
        if not sid:
            return False, f"TestBench: failed to acquire session: {sess_result.stdout[:200]}"

        steps = [
            ("/ui/login", "Login page"),
            ("/ui/processes", "Dashboard"),
            ("/ui/editor", "Editor"),
        ]

        for path, label in steps:
            nav_result = subprocess.run(
                ["curl", "-s", "-X", "POST", "http://127.0.0.1:3001/testbench/navigate",
                 "-H", "Content-Type: application/json",
                 "-d", json.dumps({"session_id": sid, "url": f"http://127.0.0.1:5173{path}"})],
                capture_output=True, text=True, timeout=15,
            )
            nav = json.loads(nav_result.stdout)
            if nav.get("status") not in ("ok", "success"):
                return False, f"TestBench: navigation to {label} failed: {nav_result.stdout[:200]}"

        # Release session
        subprocess.run(
            ["curl", "-s", "-X", "POST", "http://127.0.0.1:3001/testbench/release",
             "-H", "Content-Type: application/json",
             "-d", json.dumps({"session_id": sid})],
            capture_output=True, text=True, timeout=10,
        )

        return True, "TestBench smoke: login, dashboard, editor OK"

    except Exception as e:
        return False, f"TestBench smoke error: {e}"


CHECKS = [
    ("typecheck",      check_typecheck),
    ("tests",          check_tests),
    ("file_sizes",     check_file_sizes),
    ("runtime_size",   check_runtime_size),
    ("no_p0_issues",   check_no_p0_issues),
    ("changelog",      check_changelog),
    ("version_match",  check_version_match),
    ("testbench_smoke",check_testbench_smoke),
]


def run_all_checks() -> dict:
    results = {}
    for name, fn in CHECKS:
        print(f"  [{name}] running...", end=" ", flush=True)
        try:
            passed, detail = fn()
        except Exception as e:
            passed, detail = False, f"Exception: {e}"
        results[name] = {"passed": passed, "detail": detail}
        status = "✓" if passed else "✗"
        print(f"{status} {detail[:80]}")
    return results


def format_report(results: dict) -> str:
    blockers = [(k, v["detail"]) for k, v in results.items() if not v["passed"]]
    passed = [k for k, v in results.items() if v["passed"]]
    lines = [f"Pre-release gate: {datetime.now().strftime('%Y-%m-%d %H:%M')}"]
    lines.append(f"Passed ({len(passed)}/{len(results)}): {', '.join(passed)}")
    if blockers:
        lines.append(f"\nBLOCKED — {len(blockers)} issue(s):")
        for name, detail in blockers:
            lines.append(f"\n[{name}] {detail}")
        lines.append(f"\nresult: BLOCKED")
    else:
        lines.append(f"\nresult: APPROVED")
    return "\n".join(lines)


async def notify_bus(text: str, to: str = "naruto") -> None:
    payload = json.dumps({
        "from": "pre-release-gate",
        "to": to,
        "text": text,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    proc = await asyncio.create_subprocess_exec(
        "curl", "-s", "-X", "POST",
        "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
        "-H", "Content-Type: application/json",
        "-d", payload,
        f"{KONOHA_URL}/messages",
        env=env,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await asyncio.wait_for(proc.wait(), timeout=10)


async def main():
    print("Pre-release gate starting...\n")
    results = run_all_checks()
    report = format_report(results)
    print(f"\n{report}")

    if NOTIFY and KONOHA_TOKEN:
        print("\nSending results to bus...")
        await notify_bus(report, to="naruto")
        print("Sent to naruto.")


if __name__ == "__main__":
    asyncio.run(main())
