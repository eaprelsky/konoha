#!/usr/bin/env python3
"""
Generic watchdog for lifecycle-managed agents (launched via Konoha API).
Watches Konoha SSE stream for a given agent_id and delivers messages
to tmux session konoha-{agent_id} on the default socket.

Also supports extra Redis streams per agent (configured via AgentDef.redis_streams).

Usage: watchdog-lifecycle.py <agent_id> [agent_id2 ...]
Or: WATCHDOG_AGENTS=shino,kiba,hinata watchdog-lifecycle.py
"""

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime

# ── Config ──────────────────────────────────────────────────────────────────
KONOHA_URL   = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")

DEBOUNCE_WINDOW  = 2.0
IDLE_POLL_SEC    = 2.0
IDLE_TIMEOUT_SEC = 300
SSE_MAX_BACKOFF  = 30
WAKE_TIMEOUT_SEC = 120  # max seconds to wait for on-demand agent to start

KONOHA_REPO        = os.path.expanduser("~/konoha")
AUTO_PUSH_INTERVAL = 300  # 5 minutes — push unpushed commits (#367)

LOG_FILE = "/tmp/watchdog-lifecycle.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("watchdog-lifecycle")


def get_agents() -> list[str]:
    """Get list of agent IDs to watch."""
    if len(sys.argv) > 1:
        return sys.argv[1:]
    env = os.environ.get("WATCHDOG_AGENTS", "")
    if env:
        return [a.strip() for a in env.split(",") if a.strip()]
    return []


def tmux_session(agent_id: str) -> str:
    return agent_id


def tmux_socket(agent_id: str) -> str:
    return agent_id


def is_agent_idle(agent_id: str) -> bool:
    """Check if agent's tmux session shows the ❯ prompt (idle)."""
    session = tmux_session(agent_id)
    socket = tmux_socket(agent_id)
    try:
        result = subprocess.run(
            ["tmux", "-L", socket, "capture-pane", "-t", session, "-p"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return False
        lines = result.stdout.strip().split("\n")
        for line in reversed(lines[-5:]):
            stripped = line.strip()
            if stripped.startswith("❯") and len(stripped) < 5:
                return True
        return False
    except Exception:
        return False


def is_session_alive(agent_id: str) -> bool:
    """Check if tmux session exists on its named socket."""
    session = tmux_session(agent_id)
    socket = tmux_socket(agent_id)
    try:
        result = subprocess.run(
            ["tmux", "-L", socket, "has-session", "-t", session],
            capture_output=True, timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def has_pasted_text(agent_id: str) -> bool:
    """Check if tmux pane shows '[Pasted text' which means text wasn't submitted."""
    session = tmux_session(agent_id)
    socket = tmux_socket(agent_id)
    try:
        result = subprocess.run(
            ["tmux", "-L", socket, "capture-pane", "-t", session, "-p"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return False
        return "[Pasted text" in result.stdout
    except Exception:
        return False


async def tmux_send(agent_id: str, text: str) -> bool:
    """Send text to agent's tmux session via send-keys. Retries Enter if pasted text gets stuck."""
    session = tmux_session(agent_id)
    socket = tmux_socket(agent_id)
    try:
        proc = await asyncio.create_subprocess_exec(
            "tmux", "-L", socket, "send-keys", "-t", session, text,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5)
        if proc.returncode != 0:
            return False
        proc2 = await asyncio.create_subprocess_exec(
            "tmux", "-L", socket, "send-keys", "-t", session, "Enter",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc2.wait(), timeout=5)

        # Retry Enter if pasted text is stuck on prompt (#260)
        for retry in range(3):
            await asyncio.sleep(3)
            if not has_pasted_text(agent_id):
                break
            log.warning(f"[{agent_id}] pasted text stuck, retrying Enter (attempt {retry+1})")
            retry_proc = await asyncio.create_subprocess_exec(
                "tmux", "-L", socket, "send-keys", "-t", session, "Enter",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(retry_proc.wait(), timeout=5)

        return True
    except Exception as e:
        log.error(f"tmux_send({agent_id}) error: {e}")
        return False


# ── Agent def fetching ────────────────────────────────────────────────────────

async def fetch_agent_def(agent_id: str) -> dict | None:
    """Fetch agent definition from Konoha API to get redis_streams config."""
    try:
        import aiohttp
        url = f"{KONOHA_URL}/agents/{agent_id}"
        headers = {"Authorization": f"Bearer {KONOHA_TOKEN}"}
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    return await resp.json()
    except Exception as e:
        log.warning(f"[{agent_id}] Failed to fetch agent def: {e}")
    return None


# ── Message formatting ────────────────────────────────────────────────────────

def format_telegram_event(fields: dict) -> str:
    """Format a telegram:incoming Redis message for agent consumption."""
    sender = (fields.get("sender_name") or fields.get("sender_username")
              or fields.get("user_name") or fields.get("user", "?"))
    text = fields.get("text", "")
    ts = (fields.get("ts") or fields.get("timestamp", ""))[:16]
    chat_id = fields.get("chat_id", "")
    chat_title = fields.get("chat_title", "")
    is_group = fields.get("is_group", "0")
    sender_id = fields.get("sender_id", "")
    msg_id = fields.get("msg_id", "")
    meta = f"chat_id={chat_id}"
    if chat_title:
        meta += f" [{chat_title}]"
    if is_group in ("1", 1, True):
        meta += " [group]"
    if sender_id:
        meta += f" sender_id={sender_id}"
    if msg_id:
        meta += f" msg_id={msg_id}"
    line = f"[{ts}] {sender} ({meta}): {text}"
    attachment_path = fields.get("attachment_path", "")
    attachment_kind = fields.get("attachment_kind", "")
    if attachment_path:
        line += f"\n  [Вложение: {attachment_kind} — {attachment_path}]"
    return line


def format_reaction_event(fields: dict) -> str:
    """Format a telegram:reaction_updates Redis message."""
    user = fields.get("user", "?")
    new_r = fields.get("new_reaction", "")
    old_r = fields.get("old_reaction", "")
    msg_id = fields.get("message_id", "")
    chat_id = fields.get("chat_id", "")
    return f"  {user} поставил {new_r} (было: {old_r}) на сообщение {msg_id} в чате {chat_id}"


def build_prompt(events: list[dict]) -> str:
    """Build delivery prompt from a batch of mixed events."""
    sse_events = [e for e in events if e.get("source") == "sse"]
    tg_events = [e for e in events if e.get("source") == "redis"
                 and "telegram:incoming" in e.get("stream", "")]
    reaction_events = [e for e in events if e.get("source") == "redis"
                       and "reaction" in e.get("stream", "")]
    other_redis = [e for e in events if e.get("source") == "redis"
                   and e not in tg_events and e not in reaction_events]

    parts: list[str] = []

    if tg_events:
        parts.append("Новые сообщения в Telegram:")
        for ev in tg_events:
            parts.append(format_telegram_event(ev.get("data", {})))
        parts.append("\nОбработай и при необходимости ответь через tg-send-user.py.")

    if sse_events or other_redis:
        if parts:
            parts.append("")
        parts.append("Новые сообщения в шине Коноха:")
        for ev in sse_events:
            d = ev.get("data", {})
            sender = d.get("from", "?")
            text = d.get("text", "")
            ts = (d.get("timestamp", "") or "")[:19]
            parts.append(f"[{ts}] {sender}: {text}")
        for ev in other_redis:
            d = ev.get("data", {})
            stream = ev.get("stream", "?")
            parts.append(f"[{stream}] {json.dumps(d, ensure_ascii=False)}")
        parts.append("\nОбработай и при необходимости ответь через konoha_send.")

    if reaction_events:
        if parts:
            parts.append("")
        parts.append("Новые реакции в Telegram:")
        for ev in reaction_events:
            parts.append(format_reaction_event(ev.get("data", {})))
        parts.append("Учти реакции как обратную связь.")

    return "\n".join(parts)


# ── SSE watcher ───────────────────────────────────────────────────────────────

async def sse_watcher(agent_id: str, raw_queue: asyncio.Queue) -> None:
    """Watch Konoha SSE for a single agent and put events into raw_queue."""
    import aiohttp

    url = f"{KONOHA_URL}/messages/{agent_id}/stream"
    headers = {"Authorization": f"Bearer {KONOHA_TOKEN}"}
    backoff = 1

    log.info(f"[{agent_id}] Starting SSE watcher")

    while True:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=None)) as resp:
                    if resp.status != 200:
                        log.warning(f"[{agent_id}] SSE HTTP {resp.status}, retrying in {backoff}s")
                        await asyncio.sleep(backoff)
                        backoff = min(backoff * 2, SSE_MAX_BACKOFF)
                        continue

                    backoff = 1
                    log.info(f"[{agent_id}] SSE connected")

                    async for line in resp.content:
                        text = line.decode("utf-8", errors="replace").strip()
                        if not text or not text.startswith("data: "):
                            continue
                        try:
                            msg = json.loads(text[6:])
                        except json.JSONDecodeError:
                            continue
                        if not msg.get("text"):
                            continue
                        await raw_queue.put({"source": "sse", "data": msg})

        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.error(f"[{agent_id}] SSE error: {e}, retrying in {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, SSE_MAX_BACKOFF)


# ── Redis stream watcher ──────────────────────────────────────────────────────

async def redis_stream_watcher(
    agent_id: str, stream: str, group: str, consumer: str, raw_queue: asyncio.Queue
) -> None:
    """Watch a Redis stream via consumer group and put events into raw_queue."""
    try:
        import redis.asyncio as aioredis
    except ImportError:
        log.error(f"[{agent_id}] redis.asyncio not available — skipping Redis stream {stream}")
        return

    r = None
    backoff = 1

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host="127.0.0.1", port=6379, decode_responses=True)

            try:
                await r.xgroup_create(stream, group, id="$", mkstream=True)
                log.info(f"[{agent_id}] Created consumer group {group} on {stream}")
            except Exception as e:
                if "BUSYGROUP" not in str(e):
                    raise

            log.info(f"[{agent_id}] Redis stream watcher: {stream} (group={group}, consumer={consumer})")
            backoff = 1

            while True:
                results = await r.xreadgroup(
                    group, consumer,
                    {stream: ">"},
                    count=10,
                    block=5000,
                )
                if not results:
                    continue
                for _stream_name, messages in results:
                    for msg_id, fields in messages:
                        try:
                            action = fields.get("action_hint", "respond")
                            if action == "ignore":
                                await r.xack(stream, group, msg_id)
                                continue
                            await raw_queue.put({"source": "redis", "stream": stream, "data": fields})
                            await r.xack(stream, group, msg_id)
                        except Exception as e:
                            log.error(f"[{agent_id}] Error processing {stream} msg {msg_id}: {e}")

        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            log.warning(f"[{agent_id}] Redis watcher error ({stream}): {e!r}, retrying in {backoff}s")
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ── Delivery loop ─────────────────────────────────────────────────────────────

async def delivery_loop(agent_id: str, raw_queue: asyncio.Queue) -> None:
    """Debounce events from raw_queue and deliver batches to agent's tmux session."""
    pending: list[dict] = []
    last_event_time = 0.0

    while True:
        try:
            timeout = DEBOUNCE_WINDOW if not pending else max(0.0, DEBOUNCE_WINDOW - (time.monotonic() - last_event_time))
            event = await asyncio.wait_for(raw_queue.get(), timeout=max(0.05, timeout))
            pending.append(event)
            last_event_time = time.monotonic()
            continue
        except asyncio.TimeoutError:
            pass

        if not pending:
            continue

        # Check debounce window
        if (time.monotonic() - last_event_time) < DEBOUNCE_WINDOW:
            continue

        # Wait for agent to be idle; wake on-demand agents if session is dead
        waited = 0.0
        wake_attempted = False
        while not is_agent_idle(agent_id):
            if not is_session_alive(agent_id):
                if not wake_attempted:
                    woke = try_wake_agent(agent_id)
                    wake_attempted = True
                    if woke:
                        log.info(f"[{agent_id}] waiting for session after wake (max {WAKE_TIMEOUT_SEC}s)")
                        await asyncio.sleep(IDLE_POLL_SEC)
                        waited += IDLE_POLL_SEC
                        continue
                # Session still dead after wake attempt (or no service to start)
                log.warning(f"[{agent_id}] session dead, dropping {len(pending)} msgs")
                pending.clear()
                break
            await asyncio.sleep(IDLE_POLL_SEC)
            waited += IDLE_POLL_SEC
            if waited > max(IDLE_TIMEOUT_SEC, WAKE_TIMEOUT_SEC):
                log.warning(f"[{agent_id}] busy/not-started >{waited:.0f}s, dropping {len(pending)} msgs")
                pending.clear()
                break

        if pending:
            prompt = build_prompt(pending)
            ok = await tmux_send(agent_id, prompt)
            if ok:
                log.info(f"[{agent_id}] delivered {len(pending)} event(s)")
            else:
                log.error(f"[{agent_id}] tmux_send failed")
            pending.clear()


# ── On-demand agent wake ──────────────────────────────────────────────────────

def try_wake_agent(agent_id: str) -> bool:
    """Start a managed agent via the Konoha lifecycle API.
    Returns True if the start request succeeded."""
    try:
        env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
        result = subprocess.run(
            [
                "curl", "-sf", "-X", "POST",
                "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                f"{KONOHA_URL}/agents/{agent_id}/start",
            ],
            capture_output=True, timeout=30, env=env,
        )
        if result.returncode == 0:
            log.info(f"[{agent_id}] on-demand wake: started via lifecycle API")
            return True
        log.warning(f"[{agent_id}] failed to wake via lifecycle API: {result.stderr.decode(errors='replace')[:200]}")
        return False
    except Exception as e:
        log.warning(f"[{agent_id}] failed to wake via lifecycle API: {e}")
        return False


# ── Per-agent watcher ─────────────────────────────────────────────────────────

async def watch_agent(agent_id: str) -> None:
    """Watch SSE + optional Redis streams for a single agent."""
    raw_queue: asyncio.Queue = asyncio.Queue()

    # Fetch agent def to find any configured redis_streams
    def_data = await fetch_agent_def(agent_id)
    redis_streams: list[dict] = []
    if def_data:
        redis_streams = def_data.get("redis_streams") or []

    tasks = [
        asyncio.create_task(sse_watcher(agent_id, raw_queue), name=f"{agent_id}-sse"),
        asyncio.create_task(delivery_loop(agent_id, raw_queue), name=f"{agent_id}-delivery"),
    ]

    for s in redis_streams:
        stream = s.get("stream", "")
        group = s.get("group", agent_id)
        consumer = s.get("consumer") or f"{agent_id}-lifecycle-watchdog"
        if not stream:
            continue
        log.info(f"[{agent_id}] Adding Redis stream watcher: {stream} (group={group})")
        tasks.append(asyncio.create_task(
            redis_stream_watcher(agent_id, stream, group, consumer, raw_queue),
            name=f"{agent_id}-redis-{stream}",
        ))

    await asyncio.gather(*tasks)


async def auto_push_loop() -> None:
    """Periodically push unpushed commits from KONOHA_REPO to origin/main (#367)."""
    await asyncio.sleep(60)  # startup delay
    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "-C", KONOHA_REPO, "log", "origin/main..main", "--oneline",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            lines = [l for l in stdout.decode().strip().split("\n") if l.strip()]
            if lines:
                n = len(lines)
                log.info(f"auto-push: {n} unpushed commit(s) found, pushing to origin/main")
                push_proc = await asyncio.create_subprocess_exec(
                    "git", "-C", KONOHA_REPO, "push", "origin", "main",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, push_err = await asyncio.wait_for(push_proc.communicate(), timeout=60)
                if push_proc.returncode == 0:
                    log.info(f"auto-push: pushed {n} commit(s) to main successfully")
                    # Notify naruto via bus
                    payload = json.dumps({
                        "from": "watchdog-lifecycle",
                        "to": "naruto",
                        "text": f"watchdog-lifecycle: pushed {n} commits to main",
                        "timestamp": datetime.now().isoformat(),
                    })
                    env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
                    curl_proc = await asyncio.create_subprocess_exec(
                        "curl", "-s", "-X", "POST",
                        "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                        "-H", "Content-Type: application/json",
                        "-d", payload,
                        f"{KONOHA_URL}/messages",
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                        env=env,
                    )
                    await asyncio.wait_for(curl_proc.wait(), timeout=10)
                else:
                    log.warning(f"auto-push: git push failed: {push_err.decode()[:200]}")
        except Exception as e:
            log.warning(f"auto-push check error: {e!r}")
        await asyncio.sleep(AUTO_PUSH_INTERVAL)


async def main():
    agents = get_agents()
    if not agents:
        # Auto-discover: get all non-protected agents from Konoha API
        import aiohttp
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{KONOHA_URL}/agents",
                    headers={"Authorization": f"Bearer {KONOHA_TOKEN}"},
                ) as resp:
                    data = await resp.json()
                    all_agents = data if isinstance(data, list) else data.get("agents", [])
                    # Dedicated watchdogs keep custom logic for a small set of agents.
                    dedicated_ids = {"naruto", "sasuke", "kakashi", "kiba", "jiraiya"}
                    agents = [
                        a["id"] for a in all_agents
                        if a.get("id") and a["id"] not in dedicated_ids
                        and a.get("lifecycle", {}).get("status") == "running"
                    ]
        except Exception as e:
            log.error(f"Auto-discover failed: {e}")
            return

    if not agents:
        log.warning("No agents to watch. Exiting.")
        return

    log.info(f"Watching {len(agents)} agents: {agents}")
    tasks = [asyncio.create_task(watch_agent(aid)) for aid in agents]
    tasks.append(asyncio.create_task(auto_push_loop()))
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
