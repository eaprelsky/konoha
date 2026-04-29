#!/usr/bin/env python3
"""
Watchdog for Kakashi (Claude Agent #8, Bug Fixer).
Watches Konoha SSE /messages/kakashi/stream.
Also polls GitHub Issues every SCAN_INTERVAL seconds and delivers new issues.
Auto-push is disabled by default; set KAKASHI_AUTO_PUSH_ENABLED=1 to opt in.

Trigger messages: kakashi:fix issue=N, kakashi:scan, kakashi:review
"""
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

# ── Config ───────────────────────────────────────────────────────────────────
_b.AGENT_ID          = "kakashi"
_b.TMUX_SESSION      = "kakashi"
_b.DEBOUNCE_WINDOW   = 3.0
_b.IDLE_TIMEOUT_SEC  = 1800   # 30 min — fixes can take time
_b.STARTUP_GRACE_SEC = 120    # give startup sequence time to read memory before backlog delivery
_b.REASONING_STALL_SEC = 240  # recover if Codex stops making pane progress with no tool subprocesses
_b.BATCH_HEADER      = "Задание для Какаши:"
_b.BATCH_FOOTER      = "Выполни задание согласно AGENTS.md. Результат сообщи в Коноха."

GH_TOKEN          = os.environ.get("GH_TOKEN", "")
GH_REPO           = "eaprelsky/konoha"
SCAN_INTERVAL     = 60    # 1 minute between GitHub Issue scans
KONOHA_REPO       = os.path.expanduser("~/konoha")
AUTO_PUSH_INTERVAL = 300  # 5 minutes — push unpushed commits (#367)
AUTO_PUSH_ENABLED = os.environ.get("KAKASHI_AUTO_PUSH_ENABLED", "").lower() in {"1", "true", "yes", "on"}


# ── GitHub Issues scanner (extra_watcher) ────────────────────────────────────

async def github_issues_scanner(raw_queue: asyncio.Queue) -> None:
    """Poll GitHub Issues every SCAN_INTERVAL seconds for new open bugs."""
    if not GH_TOKEN:
        _b.log.warning("GH_TOKEN not set — GitHub Issues scanning disabled")
        return

    env = {**os.environ, "GH_TOKEN": GH_TOKEN}
    last_seen_ids: set[int] = set()
    bootstrapped = False

    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                "gh", "issue", "list",
                "--repo", GH_REPO,
                "--state", "open",
                "--json", "number,title,labels,createdAt",
                "--limit", "50",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
            issues = json.loads(stdout) if stdout else []

            if not bootstrapped:
                last_seen_ids = {i["number"] for i in issues}
                bootstrapped = True
                _b.log.info(f"GitHub scanner bootstrap: learned {len(last_seen_ids)} existing open issue(s) without dispatch")
                await asyncio.sleep(SCAN_INTERVAL)
                continue

            new_issues = [i for i in issues if i["number"] not in last_seen_ids]
            if new_issues:
                for issue in new_issues:
                    _b.log.info(f"New GitHub issue #{issue['number']}: {issue['title']}")
                    await raw_queue.put({
                        "source": "github",
                        "data": {
                            "from": "github",
                            "text": f"kakashi:fix issue={issue['number']} title={issue['title']}",
                            "timestamp": issue.get("createdAt", ""),
                        }
                    })
                    last_seen_ids.add(issue["number"])
            current_ids = {i["number"] for i in issues}
            last_seen_ids.intersection_update(current_ids)
            # No periodic kakashi:scan — tasks come from Naruto directly

        except Exception as e:
            _b.log.warning(f"GitHub scan error: {e!r}")

        await asyncio.sleep(SCAN_INTERVAL)


# ── Auto-push loop (extra_loop) ───────────────────────────────────────────────

async def auto_push_loop() -> None:
    """Periodically push unpushed commits from KONOHA_REPO to origin/main (#367).
    Restarts konoha.service after a successful push.
    """
    await asyncio.sleep(60)  # startup delay
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}

    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "-C", KONOHA_REPO, "log", "origin/main..main", "--oneline",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            lines = [l for l in stdout.decode().strip().split("\n") if l.strip()]
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
                        payload = json.dumps({
                            "from": "watchdog-kakashi",
                            "to": "naruto",
                            "text": f"Какаши: pushed {n} commits to main, konoha.service restarted",
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        })
                        curl_proc = await asyncio.create_subprocess_exec(
                            "curl", "-s", "-X", "POST",
                            "-H", f"Authorization: Bearer {_b.KONOHA_TOKEN}",
                            "-H", "Content-Type: application/json",
                            "-d", payload,
                            f"{_b.KONOHA_URL}/messages",
                            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                            env=env,
                        )
                        await asyncio.wait_for(curl_proc.wait(), timeout=10)
                    else:
                        _b.log.warning(f"auto-push: konoha.service restart failed: {restart_err.decode()[:200]}")
                else:
                    _b.log.warning(f"auto-push: git push failed: {push_err.decode()[:200]}")
        except Exception as e:
            _b.log.warning(f"auto-push check error: {e!r}")
        await asyncio.sleep(AUTO_PUSH_INTERVAL)


if __name__ == "__main__":
    if AUTO_PUSH_ENABLED:
        _b.log.warning("Kakashi auto-push enabled via KAKASHI_AUTO_PUSH_ENABLED=1")
    else:
        _b.log.info("Kakashi auto-push disabled; commits must be reviewed and pushed explicitly")

    asyncio.run(_b.run_watchdog(
        extra_watchers=[github_issues_scanner],
        extra_loops=[auto_push_loop()] if AUTO_PUSH_ENABLED else [],
    ))
