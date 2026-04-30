#!/usr/bin/env python3
"""Generic GitHub issue delegation watchdog for explicit label-based work."""

import asyncio
import json
import os
import time
from pathlib import Path
from datetime import datetime, timezone

import watchdog_base as _b


def _csv(name: str, default: str) -> set[str]:
    return {item.strip() for item in os.environ.get(name, default).split(",") if item.strip()}


def _bool(name: str, default: str = "") -> bool:
    return os.environ.get(name, default).lower() in {"1", "true", "yes", "on"}


AGENT_ID = os.environ.get("AGENT_ID", os.environ.get("KONOHA_AGENT_ID", "kakashi"))
AGENT_DISPLAY_NAME = os.environ.get("AGENT_DISPLAY_NAME", AGENT_ID)
TASK_VERB = os.environ.get("AGENT_GITHUB_TASK_VERB", "fix")

_b.AGENT_ID = AGENT_ID
_b.TMUX_SESSION = os.environ.get("AGENT_TMUX_SESSION", AGENT_ID)
_b.DEBOUNCE_WINDOW = float(os.environ.get("AGENT_DEBOUNCE_WINDOW", "3.0"))
_b.IDLE_TIMEOUT_SEC = int(os.environ.get("AGENT_IDLE_TIMEOUT_SEC", "1800"))
_b.WAKE_TIMEOUT_SEC = int(os.environ.get("AGENT_WAKE_TIMEOUT_SEC", "0"))
_b.BATCH_HEADER = os.environ.get("AGENT_BATCH_HEADER", f"Задание для {AGENT_DISPLAY_NAME}:")
_b.BATCH_FOOTER = os.environ.get(
    "AGENT_BATCH_FOOTER",
    "Выполни задание согласно AGENTS.md. Результат сообщи в Коноха.",
)

GH_TOKEN = os.environ.get("GH_TOKEN", "")
GH_REPO = os.environ.get("AGENT_GITHUB_REPO", "eaprelsky/konoha")
SCAN_INTERVAL = int(os.environ.get("AGENT_GITHUB_SCAN_INTERVAL", "60"))
KONOHA_REPO = os.path.expanduser(os.environ.get("KONOHA_REPO", "~/konoha"))
AUTO_PUSH_INTERVAL = int(os.environ.get("AGENT_AUTO_PUSH_INTERVAL", "300"))
AUTO_PUSH_ENABLED = _bool("AGENT_AUTO_PUSH_ENABLED") or (AGENT_ID == "kakashi" and _bool("KAKASHI_AUTO_PUSH_ENABLED"))
DELEGATION_LABELS = _csv("AGENT_GITHUB_DELEGATION_LABELS", "delegate:teamlead")
SKIP_LABELS = _csv("AGENT_GITHUB_SKIP_LABELS", "delegate:done,blocked")
DISPATCH_STATE_PATH = Path(os.environ.get(
    "AGENT_GITHUB_DISPATCH_STATE",
    os.path.expanduser(f"~/.cache/konoha/{AGENT_ID}-github-dispatched.json"),
))
REDISPATCH_LABELS = _csv("AGENT_GITHUB_REDISPATCH_LABELS", f"{AGENT_ID}-batch")
REDISPATCH_INTERVAL_SEC = int(os.environ.get("AGENT_GITHUB_REDISPATCH_INTERVAL_SEC", "1800"))
TASK_TEMPLATE = os.environ.get(
    "AGENT_GITHUB_TASK_TEMPLATE",
    f"{AGENT_ID}:{TASK_VERB} issue={{number}} title={{title}}",
)


def issue_label_names(issue: dict) -> set[str]:
    return {
        label.get("name", "")
        for label in issue.get("labels", [])
        if isinstance(label, dict) and label.get("name")
    }


def is_delegated_issue(issue: dict) -> bool:
    labels = issue_label_names(issue)
    return bool(labels & DELEGATION_LABELS) and not bool(labels & SKIP_LABELS)


def is_redispatchable_issue(issue: dict) -> bool:
    return bool(issue_label_names(issue) & REDISPATCH_LABELS)


def load_dispatch_state() -> tuple[set[int], dict[int, float]]:
    try:
        if not DISPATCH_STATE_PATH.exists():
            return set(), {}
        raw = json.loads(DISPATCH_STATE_PATH.read_text())
        dispatched_issue_ids = {int(issue_id) for issue_id in raw.get("dispatched_issue_ids", [])}
        dispatch_times = {
            int(issue_id): float(dispatched_at)
            for issue_id, dispatched_at in raw.get("dispatch_times", {}).items()
        }
        return dispatched_issue_ids, dispatch_times
    except Exception as e:
        _b.log.warning(f"Could not load {AGENT_ID} GitHub dispatch state: {e!r}")
        return set(), {}


def save_dispatch_state(issue_ids: set[int], dispatch_times: dict[int, float]) -> None:
    try:
        DISPATCH_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        DISPATCH_STATE_PATH.write_text(json.dumps({
            "dispatched_issue_ids": sorted(issue_ids),
            "dispatch_times": {str(issue_id): dispatch_times[issue_id] for issue_id in sorted(dispatch_times)},
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False, indent=2))
    except Exception as e:
        _b.log.warning(f"Could not save {AGENT_ID} GitHub dispatch state: {e!r}")


def should_dispatch_issue(issue: dict, dispatched_ids: set[int], dispatch_times: dict[int, float], now: float) -> bool:
    issue_number = int(issue["number"])
    if issue_number not in dispatched_ids:
        return True
    if not is_redispatchable_issue(issue):
        return False
    last_dispatched = dispatch_times.get(issue_number, 0)
    return now - last_dispatched >= REDISPATCH_INTERVAL_SEC


def task_text(issue: dict) -> str:
    return TASK_TEMPLATE.format(number=int(issue["number"]), title=issue["title"])


async def github_issues_scanner(raw_queue: asyncio.Queue) -> None:
    """Poll GitHub Issues and dispatch only issues explicitly labeled for this agent."""
    if not GH_TOKEN:
        _b.log.warning("GH_TOKEN not set — GitHub Issues scanning disabled")
        return
    if not DELEGATION_LABELS:
        _b.log.warning("AGENT_GITHUB_DELEGATION_LABELS is empty — GitHub Issues scanning disabled")
        return

    env = {**os.environ, "GH_TOKEN": GH_TOKEN}
    dispatched_ids, dispatch_times = load_dispatch_state()
    _b.log.info(
        "GitHub delegation scanner enabled: agent=%s repo=%s labels=%s skip_labels=%s redispatch_labels=%s redispatch_interval=%ss dispatched=%d",
        AGENT_ID,
        GH_REPO,
        ",".join(sorted(DELEGATION_LABELS)),
        ",".join(sorted(SKIP_LABELS)),
        ",".join(sorted(REDISPATCH_LABELS)),
        REDISPATCH_INTERVAL_SEC,
        len(dispatched_ids),
    )

    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                "gh", "issue", "list",
                "--repo", GH_REPO,
                "--state", "open",
                "--json", "number,title,labels,createdAt,updatedAt",
                "--limit", "50",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
            issues = json.loads(stdout) if stdout else []
            now = time.time()

            delegated_issues = [
                issue for issue in issues
                if is_delegated_issue(issue) and should_dispatch_issue(issue, dispatched_ids, dispatch_times, now)
            ]
            if delegated_issues:
                for issue in delegated_issues:
                    issue_number = int(issue["number"])
                    labels = ",".join(sorted(issue_label_names(issue)))
                    redispatch_note = " redispatch" if issue_number in dispatched_ids else ""
                    _b.log.info(
                        f"Delegated GitHub issue #{issue_number}{redispatch_note}: {issue['title']} labels={labels}"
                    )
                    await raw_queue.put({
                        "source": "github",
                        "data": {
                            "from": "github",
                            "text": task_text(issue),
                            "timestamp": issue.get("createdAt", ""),
                        }
                    })
                    dispatched_ids.add(issue_number)
                    dispatch_times[issue_number] = now
                save_dispatch_state(dispatched_ids, dispatch_times)

        except Exception as e:
            _b.log.warning(f"GitHub scan error: {e!r}")

        await asyncio.sleep(SCAN_INTERVAL)


async def auto_push_loop() -> None:
    """Optionally push unpushed commits from KONOHA_REPO and restart Konoha."""
    await asyncio.sleep(60)
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}

    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "-C", KONOHA_REPO, "log", "origin/main..main", "--oneline",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            lines = [line for line in stdout.decode().strip().split("\n") if line.strip()]
            if lines:
                n = len(lines)
                _b.log.info(f"auto-push: {n} unpushed commit(s) — pushing to origin/main")
                push_proc = await asyncio.create_subprocess_exec(
                    "git", "-C", KONOHA_REPO, "push", "origin", "main",
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                _, push_err = await asyncio.wait_for(push_proc.communicate(), timeout=60)
                if push_proc.returncode == 0:
                    _b.log.info(f"auto-push: pushed {n} commit(s) successfully")
                    restart_proc = await asyncio.create_subprocess_exec(
                        "sudo", "systemctl", "restart", "konoha.service",
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
                    )
                    _, restart_err = await asyncio.wait_for(restart_proc.communicate(), timeout=30)
                    if restart_proc.returncode == 0:
                        _b.log.info("auto-push: konoha.service restarted")
                        await notify_auto_push(n)
                    else:
                        _b.log.warning(f"auto-push: konoha.service restart failed: {restart_err.decode()[:200]}")
                else:
                    _b.log.warning(f"auto-push: git push failed: {push_err.decode()[:200]}")
        except Exception as e:
            _b.log.warning(f"auto-push check error: {e!r}")
        await asyncio.sleep(AUTO_PUSH_INTERVAL)


async def notify_auto_push(commit_count: int) -> None:
    target = os.environ.get("AGENT_AUTO_PUSH_NOTIFY_TO", "naruto")
    if not target:
        return
    payload = json.dumps({
        "from": f"watchdog-{AGENT_ID}",
        "to": target,
        "text": f"{AGENT_DISPLAY_NAME}: pushed {commit_count} commits to main, konoha.service restarted",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "-X", "POST",
            "-H", f"Authorization: Bearer {_b.KONOHA_TOKEN}",
            "-H", "Content-Type: application/json",
            "-d", payload,
            f"{_b.KONOHA_URL}/messages",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
        await asyncio.wait_for(proc.wait(), timeout=10)
    except Exception as e:
        _b.log.warning(f"auto-push: notify failed: {e!r}")


def main() -> None:
    if AUTO_PUSH_ENABLED:
        _b.log.warning("GitHub delegation auto-push enabled")
    else:
        _b.log.info("GitHub delegation auto-push disabled; commits must be reviewed and pushed explicitly")

    asyncio.run(_b.run_watchdog(
        extra_watchers=[github_issues_scanner],
        extra_loops=[auto_push_loop()] if AUTO_PUSH_ENABLED else [],
    ))


if __name__ == "__main__":
    main()
