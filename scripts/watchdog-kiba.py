#!/usr/bin/env python3
"""
Watchdog for Kiba (Claude Agent #7, System Guardian).
Watches Konoha SSE stream /messages/kiba/stream.
Delivers alerts from Akamaru to kiba tmux session when agent is idle.

On-demand agent: wakes via Konoha lifecycle API if session is absent.
Circuit breaker: pauses delivery for 10 min after Kiba freezes (prevents alert storm).
Freeze alerts go to Naruto (not Kiba — to break self-referential loop, see issue #111).
Extra watcher: git_push_poller sends new pushes to Shikadai for code review.

Alert messages: kiba:alert ..., kiba:healthcheck
"""
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

# ── Config ───────────────────────────────────────────────────────────────────
_b.AGENT_ID                  = "kiba"
_b.TMUX_SESSION              = "kiba"
_b.DEBOUNCE_WINDOW           = 5.0    # longer — batch multiple alerts
_b.IDLE_TIMEOUT_SEC          = 300
_b.WAKE_TIMEOUT_SEC          = 120    # on-demand: start if session absent
_b.CIRCUIT_BREAKER_DURATION  = 600    # 10 min cooldown after freeze
_b.FREEZE_ALERT_TARGET       = "naruto"  # avoid self-referential loop (#111)
_b.BATCH_HEADER              = "Задание для Кибы:"
_b.BATCH_FOOTER              = "Выполни задание согласно AGENTS.md. Результат сообщи в Коноха."

KONOHA_REPO      = os.path.expanduser("~/konoha")
GIT_POLL_INTERVAL = 300  # 5 minutes — check for new pushes to main (#363)


# ── Git push poller (extra_watcher) ──────────────────────────────────────────

async def git_push_poller(raw_queue: asyncio.Queue) -> None:  # noqa: ARG001 (not used, sends directly)
    """Poll for new pushes to origin/main every GIT_POLL_INTERVAL seconds.
    On change, fetches the diff and sends it to Shikadai via Konoha bus for code review.
    """
    await asyncio.sleep(30)  # startup delay

    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", KONOHA_REPO, "rev-parse", "origin/main",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        last_head = stdout.decode().strip()
    except Exception as e:
        _b.log.warning(f"git-poller: failed to get initial HEAD: {e!r}")
        last_head = ""

    _b.log.info(f"git-poller: starting with HEAD={last_head[:8]}")
    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}

    while True:
        await asyncio.sleep(GIT_POLL_INTERVAL)
        try:
            fetch_proc = await asyncio.create_subprocess_exec(
                "git", "-C", KONOHA_REPO, "fetch", "origin", "main",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(fetch_proc.wait(), timeout=30)

            head_proc = await asyncio.create_subprocess_exec(
                "git", "-C", KONOHA_REPO, "rev-parse", "origin/main",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            head_stdout, _ = await asyncio.wait_for(head_proc.communicate(), timeout=10)
            current_head = head_stdout.decode().strip()

            if current_head == last_head:
                continue

            _b.log.info(f"git-poller: HEAD changed {last_head[:8]} → {current_head[:8]}")

            diff_proc = await asyncio.create_subprocess_exec(
                "git", "-C", KONOHA_REPO, "diff", f"{last_head}..{current_head}", "--stat", "--no-color",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            diff_stdout, _ = await asyncio.wait_for(diff_proc.communicate(), timeout=30)
            diff_stat = diff_stdout.decode().strip()

            log_proc = await asyncio.create_subprocess_exec(
                "git", "-C", KONOHA_REPO, "log", f"{last_head}..{current_head}", "--oneline", "--no-color",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            log_stdout, _ = await asyncio.wait_for(log_proc.communicate(), timeout=10)
            commit_log = log_stdout.decode().strip()

            msg_text = (
                f"shikadai:review push={current_head[:8]} prev={last_head[:8]}\n"
                f"Commits:\n{commit_log}\n\nDiff stat:\n{diff_stat}"
            )
            if len(msg_text) > 3000:
                msg_text = msg_text[:3000] + "\n... [truncated]"

            payload = json.dumps({
                "from": f"watchdog-kiba",
                "to": "shikadai",
                "text": msg_text,
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
            _b.log.info(f"git-poller: sent diff to shikadai ({current_head[:8]})")
            last_head = current_head

        except Exception as e:
            _b.log.warning(f"git-poller error: {e!r}")


if __name__ == "__main__":
    asyncio.run(_b.run_watchdog(extra_watchers=[git_push_poller]))
