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
import re
import subprocess
import sys
import time
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
DETERMINISTIC_ALERT_COOLDOWN_SEC = int(os.environ.get("KIBA_ALERT_ACTION_COOLDOWN_SEC", "900"))

_last_alert_action: dict[tuple[str, str], float] = {}


def parse_kiba_alert(text: str) -> tuple[dict[str, str], set[str]]:
    """Extract simple key=value fields and bare alert flags from a kiba:alert text."""
    if not text.startswith("kiba:alert "):
        return {}, set()
    fields = {
        key: value.rstrip(",.;")
        for key, value in re.findall(r"([A-Za-z_][A-Za-z0-9_]*)=([^ \n]+)", text)
    }
    words = set(re.findall(r"(?<![=])\b[A-Za-z_][A-Za-z0-9_]*\b", text))
    return fields, words


def recovery_action_for_alert(text: str) -> tuple[str, str] | None:
    """Return (action, target) for alerts Kiba can handle without LLM reasoning."""
    fields, words = parse_kiba_alert(text)
    if not fields:
        return None

    agent = fields.get("agent")
    session = fields.get("session")
    target = agent or session
    if not target or not re.fullmatch(r"[A-Za-z0-9_-]+", target):
        return None

    if fields.get("watchdog") == "dead" and fields.get("session") == "alive" and agent:
        return ("restart_watchdog", agent)
    if fields.get("tmux") == "missing":
        return ("start_agent", target)
    if {"frozen", "stuck", "compacting_loop"} & words:
        return ("restart_agent", target)
    if "idle_with_messages" in words:
        return ("nudge_agent", target)
    return None


def _cooldown_allows(action: str, target: str) -> bool:
    now = time.monotonic()
    key = (action, target)
    previous = _last_alert_action.get(key, 0.0)
    if now - previous < DETERMINISTIC_ALERT_COOLDOWN_SEC:
        _b.log.info(
            "kiba-alert-handler: cooldown suppresses action=%s target=%s age=%ds",
            action,
            target,
            int(now - previous),
        )
        return False
    _last_alert_action[key] = now
    return True


async def _run_command(*args: str, timeout: float = 30.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        stdout, stderr = await proc.communicate()
        return 124, stdout.decode(errors="replace"), stderr.decode(errors="replace")
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")


async def _post_konoha_message(to: str, text: str) -> None:
    payload = json.dumps({
        "from": "watchdog-kiba",
        "to": to,
        "text": text,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    await _run_command(
        "curl", "-s", "-X", "POST",
        "-H", f"Authorization: Bearer {_b.KONOHA_TOKEN}",
        "-H", "Content-Type: application/json",
        "-d", payload,
        f"{_b.KONOHA_URL}/messages",
        timeout=10.0,
    )


async def _lifecycle_request(target: str, action: str) -> bool:
    rc, stdout, stderr = await _run_command(
        "curl", "-sf", "-X", "POST",
        "-H", f"Authorization: Bearer {_b.KONOHA_TOKEN}",
        "-H", "Content-Type: application/json",
        "-d", "{}",
        f"{_b.KONOHA_URL}/agents/{target}/{action}",
        timeout=45.0,
    )
    if rc == 0:
        return True
    _b.log.warning(
        "kiba-alert-handler: lifecycle %s failed for %s rc=%s out=%s err=%s",
        action,
        target,
        rc,
        stdout[:160],
        stderr[:160],
    )
    return False


async def _handle_recovery_action(action: str, target: str, source_text: str) -> None:
    if not _cooldown_allows(action, target):
        return

    ok = False
    detail = ""
    if action == "restart_watchdog":
        rc, _, stderr = await _run_command(
            "sudo", "systemctl", "restart", f"agent-watchdog-{target}.service",
            timeout=30.0,
        )
        ok = rc == 0
        detail = stderr[:160]
    elif action == "start_agent":
        ok = await _lifecycle_request(target, "start")
        if not ok:
            rc, _, stderr = await _run_command("sudo", "systemctl", "start", f"agent-{target}.service", timeout=30.0)
            ok = rc == 0
            detail = stderr[:160]
    elif action == "restart_agent":
        ok = await _lifecycle_request(target, "restart")
        if not ok:
            rc, _, stderr = await _run_command("sudo", "systemctl", "restart", f"agent-{target}.service", timeout=30.0)
            ok = rc == 0
            detail = stderr[:160]
    elif action == "nudge_agent":
        await _post_konoha_message(target, "kiba: nudge — you have unprocessed messages; please check your queue.")
        ok = True

    result = "ok" if ok else "failed"
    _b.log.warning(
        "kiba-alert-handler: action=%s target=%s result=%s source=%s",
        action,
        target,
        result,
        source_text[:180],
    )
    await _post_konoha_message(
        "naruto",
        f"[Kiba watchdog] deterministic recovery action={action} target={target} result={result}"
        + (f" detail={detail}" if detail and not ok else ""),
    )


async def deterministic_alert_handler(raw_queue: asyncio.Queue) -> None:  # noqa: ARG001
    """Handle routine kiba:alert recovery in code, so Kiba's LLM is not the only control loop."""
    url = f"{_b.KONOHA_URL}/messages/{_b.AGENT_ID}/stream"
    backoff = 1
    while True:
        proc = None
        try:
            _b.log.info("kiba-alert-handler: SSE connecting to %s", url)
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "-N",
                "-H", f"Authorization: Bearer {_b.KONOHA_TOKEN}",
                url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            backoff = 1
            buf = b""
            async for chunk in proc.stdout:  # type: ignore[union-attr]
                buf += chunk
                while b"\n" in buf:
                    raw_line, buf = buf.split(b"\n", 1)
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if not payload:
                        continue
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    text = data.get("text", "")
                    if not isinstance(text, str) or not text.startswith("kiba:alert "):
                        continue
                    action = recovery_action_for_alert(text)
                    if action:
                        await _handle_recovery_action(action[0], action[1], text)
            rc = await proc.wait()
            _b.log.warning("kiba-alert-handler: curl exited with code %s", rc)
        except asyncio.CancelledError:
            if proc and proc.returncode is None:
                proc.kill()
            raise
        except Exception as e:
            _b.log.warning("kiba-alert-handler error: %r", e)
        finally:
            if proc and proc.returncode is None:
                proc.kill()
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, _b.SSE_MAX_BACKOFF)


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
    asyncio.run(_b.run_watchdog(extra_watchers=[git_push_poller, deterministic_alert_handler]))
