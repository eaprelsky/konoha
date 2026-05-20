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
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from service_profiles import resolve_service_profile_from_env

# ── Config ──────────────────────────────────────────────────────────────────
KONOHA_URL   = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")

DEBOUNCE_WINDOW  = 2.0
IDLE_POLL_SEC    = 2.0
IDLE_TIMEOUT_SEC = 300
SSE_MAX_BACKOFF  = 30
SSE_MAX_REPLAY_AGE = 600
SSE_DELIVERED_DEDUP_TTL_SEC = 7 * 86400
SSE_DELIVERED_DEDUP_MAX_SIZE = 5000
WAKE_TIMEOUT_SEC = 120  # max seconds to wait for on-demand agent to start

KONOHA_REPO        = os.path.expanduser("~/konoha")
AUTO_PUSH_INTERVAL = 300  # 5 minutes — push unpushed commits (#367)

LOG_FILE = "/tmp/watchdog-lifecycle.log"
DISABLED_EXPERIMENT_AGENTS = {"jiraiya"}
DISABLED_EXPERIMENT_OVERRIDE_ENV = "KONOHA_ENABLE_DISABLED_EXPERIMENT_AGENTS"
DISABLED_LIFECYCLE_OVERRIDE_ENV = "KONOHA_ENABLE_DISABLED_LIFECYCLE_AGENTS"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("watchdog-lifecycle")


def parse_csv(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def disabled_experiment_allowed(agent_id: str, environ: dict[str, str] | None = None) -> bool:
    env = environ or os.environ
    enabled = set(parse_csv(env.get(DISABLED_EXPERIMENT_OVERRIDE_ENV, "")))
    return "all" in enabled or agent_id in enabled


def disabled_lifecycle_allowed(agent_id: str, environ: dict[str, str] | None = None) -> bool:
    env = environ or os.environ
    enabled = set(parse_csv(env.get(DISABLED_LIFECYCLE_OVERRIDE_ENV, "")))
    return "all" in enabled or agent_id in enabled


def profile_allows_lifecycle_watch(agent_id: str, environ: dict[str, str] | None = None) -> bool:
    env = environ or os.environ
    try:
        profile = resolve_service_profile_from_env(env)
    except Exception as e:
        log.warning("could not resolve service profile for lifecycle watchdog filtering: %r", e)
        return True
    override_allowed = disabled_lifecycle_allowed(agent_id, env)
    if agent_id in profile.disabled_lifecycle_agents and not override_allowed:
        log.warning(
            "agent %s removed from lifecycle watch list by service profile %s disabled_lifecycle_agents; set %s=%s for explicit override",
            agent_id,
            profile.id,
            DISABLED_LIFECYCLE_OVERRIDE_ENV,
            agent_id,
        )
        return False
    if profile.lifecycle_watchdog_agents:
        return agent_id in profile.lifecycle_watchdog_agents or override_allowed
    return override_allowed


def filter_watch_agents(agent_ids: list[str], environ: dict[str, str] | None = None) -> list[str]:
    env = environ or os.environ
    filtered: list[str] = []
    for agent_id in agent_ids:
        if agent_id in DISABLED_EXPERIMENT_AGENTS and not disabled_experiment_allowed(agent_id, env):
            log.warning(
                "disabled experiment agent %s removed from lifecycle watch list; set %s=%s for approved rollback",
                agent_id,
                DISABLED_EXPERIMENT_OVERRIDE_ENV,
                agent_id,
            )
            continue
        if not profile_allows_lifecycle_watch(agent_id, env):
            log.info("agent %s removed from lifecycle watch list by selected service profile", agent_id)
            continue
        filtered.append(agent_id)
    return filtered


def get_agents() -> list[str]:
    """Get list of agent IDs to watch."""
    if len(sys.argv) > 1:
        return filter_watch_agents(sys.argv[1:])
    env = os.environ.get("WATCHDOG_AGENTS", "")
    if env:
        return filter_watch_agents(parse_csv(env))
    return []


def tmux_session(agent_id: str) -> str:
    return agent_id


def tmux_socket(agent_id: str) -> str:
    return agent_id


def pane_is_idle(content: str) -> bool:
    lines = [line.strip() for line in content.strip().split("\n") if line.strip()]
    last_lines = lines[-12:]
    has_claude_prompt = any(
        (line == "❯" or line == "❯\xa0" or line.startswith("❯ ") or line.startswith("❯\xa0"))
        and "Pasted text" not in line
        for line in last_lines
    )
    has_codex_prompt = any(line.startswith("› ") for line in last_lines)
    has_cursor_ready = (
        any("→ Add a follow-up" in line for line in last_lines)
        or any("ctrl+c to stop" in line for line in last_lines)
        or any("▶︎ Auto-run everything" in line for line in last_lines)
    )
    has_opencode_idle = (
        any("ctrl+p commands" in line for line in last_lines)
        or any("tab agents" in line for line in last_lines)
    )
    return has_claude_prompt or has_codex_prompt or has_cursor_ready or has_opencode_idle


def is_agent_idle(agent_id: str) -> bool:
    """Check if agent's tmux session shows a supported ready-for-input prompt."""
    session = tmux_session(agent_id)
    socket = tmux_socket(agent_id)
    if not is_session_alive(agent_id):
        return False
    try:
        result = subprocess.run(
            ["tmux", "-L", socket, "capture-pane", "-t", session, "-p"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return False
        return pane_is_idle(result.stdout)
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
    """Send text to agent's tmux session and confirm submission only after it leaves idle."""
    session = tmux_session(agent_id)
    socket = tmux_socket(agent_id)

    def pane_content() -> str:
        try:
            result = subprocess.run(
                ["tmux", "-L", socket, "capture-pane", "-t", session, "-p"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode != 0:
                return ""
            return result.stdout
        except Exception:
            return ""

    async def dismiss_pasted_dialog() -> None:
        for _ in range(5):
            if not has_pasted_text(agent_id):
                return
            log.warning(f"[{agent_id}] [Pasted text] dialog detected — sending Enter to dismiss")
            proc = await asyncio.create_subprocess_exec(
                "tmux", "-L", socket, "send-keys", "-t", session, "Enter",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=5)
            await asyncio.sleep(0.6)

    async def retype_prompt() -> bool:
        proc_clear = await asyncio.create_subprocess_exec(
            "tmux", "-L", socket, "send-keys", "-t", session, "C-u",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc_clear.wait(), timeout=5)
        await asyncio.sleep(0.15)
        proc_type = await asyncio.create_subprocess_exec(
            "tmux", "-L", socket, "send-keys", "-t", session, text,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc_type.wait(), timeout=5)
        if proc_type.returncode != 0:
            return False
        await asyncio.sleep(0.35)
        await dismiss_pasted_dialog()
        return True

    async def wait_for_submit(timeout_sec: float) -> bool:
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            if not is_session_alive(agent_id):
                log.error(f"[{agent_id}] delivery failed: tmux session disappeared during submit")
                return False
            content = pane_content()
            if "Pasted text" in content:
                log.warning(f"[{agent_id}] [Pasted text] appeared after submit — sending Enter")
                proc_enter = await asyncio.create_subprocess_exec(
                    "tmux", "-L", socket, "send-keys", "-t", session, "Enter",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(proc_enter.wait(), timeout=5)
                await asyncio.sleep(0.6)
                continue
            if content.strip() and not is_agent_idle(agent_id):
                log.info(f"[{agent_id}] Delivery confirmed: agent left idle state after submit")
                return True
            await asyncio.sleep(0.4)
        return False


    try:
        proc = await asyncio.create_subprocess_exec(
            "tmux", "-L", socket, "send-keys", "-t", session, text,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.wait(), timeout=5)
        if proc.returncode != 0:
            return False

        await asyncio.sleep(0.5)
        await dismiss_pasted_dialog()

        for attempt in range(4):
            if attempt == 1:
                log.warning(f"[{agent_id}] agent stayed idle after submit attempt 1 — retrying Enter")
            elif attempt >= 2:
                log.warning(f"[{agent_id}] agent stayed idle after submit attempt {attempt} — clearing input and retyping prompt")
                if not await retype_prompt():
                    return False

            proc_enter = await asyncio.create_subprocess_exec(
                "tmux", "-L", socket, "send-keys", "-t", session, "Enter",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc_enter.wait(), timeout=5)
            if await wait_for_submit(4.0 if attempt == 0 else 3.0):
                return True

        log.error(f"[{agent_id}] delivery failed: agent stayed idle after submit retries")
        return False
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
    text = _sanitize_text(text)
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


def _sanitize_text(text: str) -> str:
    """Fix literal \\n → real newlines and MarkdownV2 escape artifacts (#505)."""
    if not text:
        return text
    import re
    text = text.replace("\\n", "\n")
    text = re.sub(r"\\([!./\-_{}()#>+*=|~`])", r"\1", text)
    return text


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
            text = _sanitize_text(d.get("text", ""))
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


_delivered_sse_ids: dict[str, dict[str, float]] = {}


def _sse_dedup_path(agent_id: str) -> Path:
    return Path(os.environ.get(
        "WATCHDOG_LIFECYCLE_SSE_DEDUP_DIR",
        os.path.expanduser("~/.cache/konoha"),
    )) / f"{agent_id}-lifecycle-sse-delivered.json"


def _load_delivered_sse_ids(agent_id: str) -> dict[str, float]:
    if agent_id in _delivered_sse_ids:
        return _delivered_sse_ids[agent_id]

    now = time.time()
    state: dict[str, float] = {}
    try:
        raw = json.loads(_sse_dedup_path(agent_id).read_text())
        items = raw.get("ids", raw) if isinstance(raw, dict) else {}
        if isinstance(items, dict):
            for key, ts in items.items():
                try:
                    t = float(ts)
                except (TypeError, ValueError):
                    continue
                if now - t <= SSE_DELIVERED_DEDUP_TTL_SEC:
                    state[str(key)] = t
    except FileNotFoundError:
        pass
    except Exception as e:
        log.warning(f"[{agent_id}] could not load SSE dedup state: {e!r}")

    _delivered_sse_ids[agent_id] = state
    return state


def _save_delivered_sse_ids(agent_id: str) -> None:
    state = _load_delivered_sse_ids(agent_id)
    now = time.time()
    fresh = {key: ts for key, ts in state.items() if now - ts <= SSE_DELIVERED_DEDUP_TTL_SEC}
    if len(fresh) > SSE_DELIVERED_DEDUP_MAX_SIZE:
        fresh = dict(sorted(fresh.items(), key=lambda item: item[1])[-SSE_DELIVERED_DEDUP_MAX_SIZE:])
    state.clear()
    state.update(fresh)

    path = _sse_dedup_path(agent_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps({"ids": state, "updated_at": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False))
        tmp.replace(path)
    except Exception as e:
        log.warning(f"[{agent_id}] could not save SSE dedup state: {e!r}")


def _sse_delivery_id(ev: dict) -> str:
    if ev.get("source") != "sse":
        return ""
    data = ev.get("data", ev)
    if not isinstance(data, dict):
        return ""
    return str(data.get("_sse_id") or data.get("id") or "")


def filter_delivered_sse_events(agent_id: str, batch: list[dict], pending: list[dict]) -> list[dict]:
    delivered = _load_delivered_sse_ids(agent_id)
    pending_ids = {_sse_delivery_id(ev) for ev in pending}
    seen_in_batch: set[str] = set()
    fresh: list[dict] = []

    for ev in batch:
        msg_id = _sse_delivery_id(ev)
        if not msg_id:
            fresh.append(ev)
            continue
        if msg_id in delivered:
            log.info(f"[{agent_id}] SSE delivered dedup: skipping already delivered message {msg_id}")
            continue
        if msg_id in pending_ids or msg_id in seen_in_batch:
            log.info(f"[{agent_id}] SSE delivered dedup: skipping duplicate pending message {msg_id}")
            continue
        seen_in_batch.add(msg_id)
        fresh.append(ev)
    return fresh


def mark_sse_events_delivered(agent_id: str, events: list[dict]) -> None:
    ids = [_sse_delivery_id(ev) for ev in events]
    ids = [msg_id for msg_id in ids if msg_id]
    if not ids:
        return
    state = _load_delivered_sse_ids(agent_id)
    now = time.time()
    for msg_id in ids:
        state[msg_id] = now
    _save_delivered_sse_ids(agent_id)
    log.info(f"[{agent_id}] SSE delivered dedup: marked {len(set(ids))} message id(s) delivered")


# ── SSE watcher ───────────────────────────────────────────────────────────────

async def sse_watcher(agent_id: str, raw_queue: asyncio.Queue) -> None:
    """Watch Konoha SSE for a single agent and put events into raw_queue."""
    import aiohttp

    url = f"{KONOHA_URL}/messages/{agent_id}/stream"
    backoff = 1
    last_event_id = ""
    last_event_id_time = 0.0

    log.info(f"[{agent_id}] Starting SSE watcher")

    while True:
        try:
            headers = {"Authorization": f"Bearer {KONOHA_TOKEN}"}
            if last_event_id:
                id_age = time.monotonic() - last_event_id_time if last_event_id_time else float("inf")
                if id_age > SSE_MAX_REPLAY_AGE:
                    log.warning(f"[{agent_id}] SSE Last-Event-ID is {int(id_age)}s old — clearing to avoid replay flood")
                    last_event_id = ""
                else:
                    headers["Last-Event-ID"] = last_event_id
                    log.info(f"[{agent_id}] SSE reconnecting with Last-Event-ID={last_event_id}")
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
                        if not text:
                            continue
                        if text.startswith("id:"):
                            last_event_id = text[3:].strip()
                            last_event_id_time = time.monotonic()
                            continue
                        if not text.startswith("data: "):
                            continue
                        try:
                            msg = json.loads(text[6:])
                        except json.JSONDecodeError:
                            continue
                        if not msg.get("text"):
                            continue
                        if last_event_id:
                            msg["_sse_id"] = last_event_id
                        await raw_queue.put({"source": "sse", "data": msg})

        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.error(f"[{agent_id}] SSE error: {e}, retrying in {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, SSE_MAX_BACKOFF)


# ── Redis stream watcher ──────────────────────────────────────────────────────

_created_groups: set[str] = set()

def _forget_group_if_missing(err: Exception, stream: str, group: str) -> None:
    text = str(err)
    if "NOGROUP" in text or "no such key" in text.lower():
        _created_groups.discard(f"{stream}:{group}")

async def _ensure_group_once(r, stream: str, group: str, id: str = "$") -> None:
    """Cache XGROUP CREATE to avoid Redis churn on every reconnect (#780)."""
    key = f"{stream}:{group}"
    if key in _created_groups:
        return
    try:
        await r.xgroup_create(stream, group, id=id, mkstream=True)
        _created_groups.add(key)
    except Exception as e:
        if "BUSYGROUP" not in str(e):
            raise
        _created_groups.add(key)


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

            await _ensure_group_once(r, stream, group)

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
            _forget_group_if_missing(e, stream, group)
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
            fresh = filter_delivered_sse_events(agent_id, [event], pending)
            pending.extend(fresh)
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
                log.warning(f"[{agent_id}] desync: busy >{waited:.0f}s — attempting lifecycle restart (#505)")
                restarted = try_restart_agent(agent_id)
                if restarted:
                    log.info(f"[{agent_id}] desync recovery: restart requested, waiting 30s")
                    await asyncio.sleep(30)
                    for _ in range(20):
                        if is_session_alive(agent_id) and is_agent_idle(agent_id):
                            log.info(f"[{agent_id}] desync recovery: agent idle, re-dispatching {len(pending)} msg(s)")
                            break
                        await asyncio.sleep(5)
                    continue
                log.warning(f"[{agent_id}] desync recovery failed, dropping {len(pending)} msgs")
                pending.clear()
                break

        if pending:
            prompt = build_prompt(pending)
            prompt = _sanitize_text(prompt)
            ok = await tmux_send(agent_id, prompt)
            if ok:
                log.info(f"[{agent_id}] delivered {len(pending)} event(s)")
                mark_sse_events_delivered(agent_id, pending)
            else:
                log.error(f"[{agent_id}] tmux_send failed")
            pending.clear()


# ── On-demand agent wake ──────────────────────────────────────────────────────

def request_lifecycle(agent_id: str, action: str) -> bool:
    """Call a Konoha lifecycle action for a managed agent."""
    try:
        env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
        result = subprocess.run(
            [
                "curl", "-sf", "-X", "POST",
                "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                f"{KONOHA_URL}/agents/{agent_id}/{action}",
            ],
            capture_output=True, timeout=30, env=env,
        )
        if result.returncode == 0:
            log.info(f"[{agent_id}] lifecycle {action}: request accepted")
            return True
        log.warning(f"[{agent_id}] lifecycle {action} failed: {result.stderr.decode(errors='replace')[:200]}")
        return False
    except Exception as e:
        log.warning(f"[{agent_id}] lifecycle {action} failed: {e}")
        return False


def try_wake_agent(agent_id: str) -> bool:
    """Start a managed agent via the Konoha lifecycle API."""
    return request_lifecycle(agent_id, "start")


def try_restart_agent(agent_id: str) -> bool:
    """Restart a desynchronized managed agent via the Konoha lifecycle API."""
    return request_lifecycle(agent_id, "restart")


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
                    # Dedicated watchdogs keep custom logic; disabled experiments must not be auto-discovered.
                    dedicated_ids = {"naruto", "sasuke", "kakashi", "kiba"}
                    agents = filter_watch_agents([
                        a["id"] for a in all_agents
                        if a.get("id") and a["id"] not in dedicated_ids
                        and a.get("lifecycle", {}).get("status") == "running"
                    ])
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
