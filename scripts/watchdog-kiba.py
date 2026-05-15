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
# Self-target protection: never auto-restart kiba via deterministic handler (#794 review)
KIBA_SELF_TARGET_KILLSWITCH = os.environ.get("KIBA_SELF_TARGET_KILLSWITCH", "1") == "1"
# Min credible stuck duration: alerts claiming shorter than this are noise (seconds)
KIBA_MIN_CREDIBLE_STUCK_SEC = int(os.environ.get("KIBA_MIN_CREDIBLE_STUCK_SEC", "300"))
# Max restarts per target per storm window (0 = disabled)
KIBA_STORM_MAX_RESTARTS = int(os.environ.get("KIBA_STORM_MAX_RESTARTS", "3"))
KIBA_STORM_WINDOW_SEC = int(os.environ.get("KIBA_STORM_WINDOW_SEC", "3600"))
_storm_counter: dict[str, list[float]] = {}  # target -> list of restart timestamps


def _get_claude_process_uptime(target: str) -> float | None:
    """Return uptime in seconds of the target agent's CLI process, or None.

    Tries multiple detection strategies because target names are not guaranteed
    in process argv (Shikadai review finding #2, refs #794):
    1. pgrep for claude/codex/opencode containing target name
    2. Fallback: tmux pane PID descendant search
    """
    pids: list[str] = []
    try:
        for runtime in ["claude", "codex", "opencode"]:
            result = subprocess.run(
                ["pgrep", "-f", f"{runtime}.*{target}"],
                capture_output=True, text=True, timeout=5,
            )
            found = result.stdout.strip().split()
            if found:
                pids.extend(found)
                break  # first matching runtime wins
        # Fallback: search descendants of tmux pane PID
        if not pids:
            pid = _b.tmux_pane_pid(target)
            if pid:
                pids = [str(pid)]
        if not pids:
            return None
        # Use the first matching PID
        pid = pids[0]
        # Read process start time from /proc/pid/stat (field 22 = starttime in clock ticks)
        stat = open(f"/proc/{pid}/stat").read()
        # field 22 is after the comm field (field 2) which may contain spaces in parens
        # Parse: split after the closing paren
        after_comm = stat.rsplit(")", 1)[1].split()
        starttime_ticks = int(after_comm[19])  # field 22, 0-indexed from after_comm
        # Convert clock ticks to seconds
        ticks_per_sec = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
        uptime_sec = time.time() - (starttime_ticks / ticks_per_sec)
        # Also read /proc/uptime for the system boot offset
        with open("/proc/uptime") as f:
            system_uptime = float(f.read().split()[0])
        # starttime is relative to boot; uptime since process start:
        boot_time = time.time() - system_uptime
        process_start = boot_time + (starttime_ticks / ticks_per_sec)
        return max(0.0, time.time() - process_start)
    except Exception:
        return None


def _storm_allows(target: str) -> bool:
    """Return False if too many restarts for target in the storm window."""
    if KIBA_STORM_MAX_RESTARTS <= 0:
        return True
    now = time.monotonic()
    ts_list = _storm_counter.setdefault(target, [])
    # Prune old entries
    ts_list[:] = [t for t in ts_list if now - t < KIBA_STORM_WINDOW_SEC]
    if len(ts_list) >= KIBA_STORM_MAX_RESTARTS:
        _b.log.warning(
            "kiba-alert-handler: storm breaker blocks restart target=%s count=%d window=%ds",
            target, len(ts_list), KIBA_STORM_WINDOW_SEC,
        )
        return False
    ts_list.append(now)
    return True


def _validate_stuck_alert(agent: str, text: str) -> bool:
    """Return False if the alert is likely a false Akamaru alarm.

    Covers stuck, compacting_loop, and frozen alerts (Shikadai review #2, refs #794).
    Fail-closed: when process uptime cannot be determined, block the restart
    rather than allowing a potentially unsafe action on a missing agent.
    """
    import re as _re
    # Match stuck/compacting_loop/frozen duration patterns
    m = _re.search(r"(?:stuck|compacting_loop|frozen)\s+duration[=:]\s*(\d+)\s*min", text, _re.IGNORECASE)
    if not m:
        # Also match frozen=permission_prompt (no duration)
        if "frozen=permission_prompt" in text.lower():
            return True  # permission prompts are real — allow restart
        return True  # no duration to validate — allow (recognized pattern)
    claimed_min = int(m.group(1))
    claimed_sec = claimed_min * 60
    if claimed_sec < KIBA_MIN_CREDIBLE_STUCK_SEC:
        return True  # below noise floor — allow
    uptime = _get_claude_process_uptime(agent)
    if uptime is None:
        # Fail-closed: cannot verify process → block restart, audit-only
        _b.log.warning(
            "kiba-alert-handler: cannot determine process uptime for %s — blocking restart (fail-closed)",
            agent,
        )
        return False
    # If the process has been running less than half the claimed stuck duration,
    # this is a false alarm (Akamaru referencing old/stale metrics)
    if uptime < claimed_sec * 0.5:
        _b.log.warning(
            "kiba-alert-handler: false alert for %s — claimed=%dmin actual_uptime=%ds — skipping",
            agent, claimed_min, int(uptime),
        )
        return False
    return True

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
    """Return (action, target) for alerts Kiba can handle without LLM reasoning.

    Safety gates (refs #794 Shikadai review):
    - Self-target kill-switch: never auto-restart kiba via deterministic path
    - False-alert validation: skip akamaru alerts when claimed duration
      far exceeds actual process uptime (fail-closed)
    - Storm breaker: cap restarts per target per time window

    When a safety gate blocks the action, returns ("audit", reason) so the
    handler sends a Konoha audit message instead of silently dropping.
    """
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
        # Self-target kill-switch: kiba cannot deterministically restart itself
        if KIBA_SELF_TARGET_KILLSWITCH and target == _b.AGENT_ID:
            _b.log.warning(
                "kiba-alert-handler: self-target kill-switch blocks restart_agent for %s",
                target,
            )
            return ("audit", f"self-target kill-switch blocked restart_agent for {target}")
        # False-alert validation: skip akamaru stale alerts (fail-closed)
        if not _validate_stuck_alert(target, text):
            return ("audit", f"false-alert validation blocked restart_agent for {target}")
        # Storm breaker: cap restarts per target per window
        if not _storm_allows(target):
            return ("audit", f"storm breaker blocked restart_agent for {target} (max {KIBA_STORM_MAX_RESTARTS}/{KIBA_STORM_WINDOW_SEC}s)")
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
                    result = recovery_action_for_alert(text)
                    if result:
                        action, target_or_reason = result
                        if action == "audit":
                            await _post_konoha_message(
                                "naruto",
                                f"[Kiba watchdog] audit-only: {target_or_reason} | alert={text[:200]}",
                            )
                        else:
                            await _handle_recovery_action(action, target_or_reason, text)
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
