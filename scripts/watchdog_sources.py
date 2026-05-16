#!/usr/bin/env python3
"""
watchdog_sources — event source watchers for Konoha watchdogs.

Extracted from watchdog.py (#573). Imported by watchdog.py.

Source watchers:
  - konoha_sse_watcher: Konoha bus SSE stream
  - telegram_queue_watcher: Telegram message-queue.jsonl file
  - reaction_queue_watcher: Telegram reaction-queue.jsonl file
  - telegram_redis_watcher: Redis stream consumer
  - redis_reactions_watcher: Redis reactions stream consumer
  - github_issues_scanner: GitHub Issues poller
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from watchdog_tmux import is_session_alive, is_agent_idle
from watchdog_format import is_session_noise

log = logging.getLogger(__name__)

KONOHA_URL   = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
GH_TOKEN     = os.environ.get("GH_TOKEN", "")
REDIS_HOST   = os.environ.get("REDIS_HOST", "127.0.0.1")
REDIS_PORT   = int(os.environ.get("REDIS_PORT", "6379"))

SSE_MAX_BACKOFF = 60

# Shared health tracker (for health monitor — used by sasuke)
_health: dict = {
    "last_received_at": 0.0,
    "last_delivered_at": 0.0,
}

def get_health() -> dict:
    return _health


# ── Konoha SSE watcher ────────────────────────────────────────────────────────

async def konoha_sse_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """Read Konoha SSE stream via curl. Supports Last-Event-ID replay on reconnect."""
    agent_id = cfg["agent_id"]
    url = f"{KONOHA_URL}/messages/{agent_id}/stream"
    backoff = 1
    last_event_id = ""
    last_event_time = [0.0]  # mutable container for stale_checker
    SSE_STALE_TIMEOUT = cfg.get("sse_stale_timeout", 300)

    while True:
        proc = None
        try:
            extra_headers: list[str] = []
            if last_event_id:
                extra_headers = ["-H", f"Last-Event-ID: {last_event_id}"]
                log.info(f"SSE reconnecting with Last-Event-ID={last_event_id} to {url}")
            else:
                log.info(f"SSE connecting via curl to {url}")
            env = {**os.environ, "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost"}
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "-N",
                "-H", f"Authorization: Bearer {KONOHA_TOKEN}",
                *extra_headers,
                url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
            )

            backoff = 1
            buf = b""
            last_event_time[0] = asyncio.get_running_loop().time()

            async def stale_checker(p: asyncio.subprocess.Process) -> None:
                while p.returncode is None:
                    await asyncio.sleep(60)
                    elapsed = asyncio.get_running_loop().time() - last_event_time[0]
                    if elapsed > SSE_STALE_TIMEOUT and p.returncode is None:
                        log.warning(f"SSE stale: no event in {int(elapsed)}s — forcing reconnect")
                        p.kill()
                        return

            stale_task = asyncio.create_task(stale_checker(proc))

            try:
                async for chunk in proc.stdout:  # type: ignore
                    buf += chunk
                    while b"\n" in buf:
                        raw_line, buf = buf.split(b"\n", 1)
                        line = raw_line.decode("utf-8", errors="replace").strip()
                        if line.startswith("id:"):
                            last_event_id = line[3:].strip()
                            last_event_time[0] = asyncio.get_running_loop().time()
                            continue
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload:
                            continue
                        try:
                            data = json.loads(payload)
                            log.info(f"SSE event from {data.get('from','?')}: {data.get('text','')[:60]}")
                            if is_session_noise(data):
                                log.debug(f"Skipping SESSION noise: {data.get('text','')[:50]}")
                                continue
                            last_event_time[0] = asyncio.get_running_loop().time()
                            _health["last_received_at"] = last_event_time[0]
                            await raw_queue.put({"source": "konoha", "data": data})
                        except json.JSONDecodeError:
                            pass
            finally:
                stale_task.cancel()

            rc = await proc.wait()
            log.warning(f"curl exited with code {rc}, retrying in {backoff}s")

        except asyncio.CancelledError:
            if proc:
                proc.kill()
            raise
        except Exception as e:
            log.warning(f"SSE watcher error: {e!r}, retrying in {backoff}s")
        finally:
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                except Exception:
                    pass

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, SSE_MAX_BACKOFF)


# ── Telegram file watcher ─────────────────────────────────────────────────────

async def telegram_queue_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """
    Tail message-queue.jsonl and emit new messages.
    Tracks last seen message_id to avoid replaying old messages on restart.
    Requires cfg["telegram_file"].
    """
    agent_id = cfg["agent_id"]
    queue_path = Path(os.path.expanduser(cfg["telegram_file"]))
    last_id_file = Path(f"/tmp/watchdog-{agent_id}-last-tg-id")

    last_id = 0
    if last_id_file.exists():
        try:
            last_id = int(last_id_file.read_text().strip())
        except Exception:
            pass

    if last_id == 0 and queue_path.exists():
        try:
            lines = queue_path.read_text().strip().splitlines()
            if lines:
                last_line = json.loads(lines[-1])
                last_id = int(last_line.get("message_id", 0))
                last_id_file.write_text(str(last_id))
                log.info(f"Seeded last Telegram message_id={last_id}")
        except Exception as e:
            log.warning(f"Could not seed last_id: {e}")

    log.info(f"Watching {queue_path}, last_id={last_id}")

    backoff = 1
    while True:
        try:
            if not queue_path.exists():
                await asyncio.sleep(5)
                continue

            lines = queue_path.read_text().strip().splitlines()
            new_events = []
            for line in lines:
                try:
                    msg = json.loads(line)
                    mid = int(msg.get("message_id", 0))
                    if mid > last_id and msg.get("action_hint") in ("respond", "observe"):
                        new_events.append(msg)
                        if mid > last_id:
                            last_id = mid
                except Exception:
                    pass

            if new_events:
                last_id_file.write_text(str(last_id))
                for msg in new_events:
                    log.info(f"TG message from {msg.get('user','?')}: {msg.get('text','')[:60]}")
                    await raw_queue.put({"source": "telegram", "data": msg})

            backoff = 1
            await asyncio.sleep(1.0)

        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning(f"TG watcher error: {e!r}, retrying in {backoff}s")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ── Telegram reactions file watcher ──────────────────────────────────────────

_SEEN_REACTIONS_MAX = 500


def _load_seen_reactions(path: Path) -> set:
    if path.exists():
        try:
            return set(tuple(x) for x in json.loads(path.read_text()))
        except Exception:
            pass
    return set()


def _save_seen_reactions(path: Path, seen: set) -> None:
    try:
        path.write_text(json.dumps(list(seen)))
    except Exception as e:
        log.warning(f"Could not persist seen reactions: {e}")


async def reaction_queue_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """Watch reaction-queue.jsonl and deliver new reactions.
    Requires cfg["reaction_file"].
    """
    agent_id = cfg["agent_id"]
    reaction_path = Path(os.path.expanduser(cfg["reaction_file"]))
    seen_file = Path(f"/tmp/watchdog-{agent_id}-seen-reactions.json")
    seen: set = _load_seen_reactions(seen_file)

    if not seen and reaction_path.exists():
        try:
            lines = reaction_path.read_text().strip().splitlines()
            for line in lines:
                try:
                    r = json.loads(line)
                    sig = (str(r.get("message_id", "")), r.get("new_reaction", ""), r.get("user", ""))
                    seen.add(sig)
                except Exception:
                    pass
            _save_seen_reactions(seen_file, seen)
            log.info(f"Seeded seen reactions: {len(seen)} entries")
        except Exception as e:
            log.warning(f"Could not seed seen reactions: {e}")

    while True:
        try:
            if not reaction_path.exists():
                await asyncio.sleep(5)
                continue

            lines = reaction_path.read_text().strip().splitlines()
            new_reactions = []
            for line in lines:
                try:
                    r = json.loads(line)
                    if not r.get("new_reaction"):
                        continue
                    sig = (str(r.get("message_id", "")), r.get("new_reaction", ""), r.get("user", ""))
                    if sig not in seen:
                        new_reactions.append(r)
                        seen.add(sig)
                except Exception:
                    pass

            if new_reactions:
                if len(seen) > _SEEN_REACTIONS_MAX:
                    seen = set(list(seen)[-_SEEN_REACTIONS_MAX:])
                _save_seen_reactions(seen_file, seen)
                for r in new_reactions:
                    emoji = r.get("new_reaction", "?")
                    user = r.get("user", "?")
                    msg_id = r.get("message_id", "?")
                    log.info(f"Reaction {emoji} from {user} on msg {msg_id}")
                    await raw_queue.put({"source": "reaction", "data": r})

            await asyncio.sleep(1.0)

        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning(f"Reaction watcher error: {e!r}")
            await asyncio.sleep(5)


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

async def telegram_redis_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """Read a Redis stream via consumer group.
    Requires cfg["redis_stream"] = {"stream": ..., "group": ..., "consumer": ...}
    """
    try:
        import redis.asyncio as aioredis
    except ImportError:
        log.error("redis.asyncio not installed — redis-stream source disabled")
        return

    rs_cfg   = cfg["redis_stream"]
    stream   = rs_cfg["stream"]
    group    = rs_cfg["group"]
    consumer = rs_cfg["consumer"]

    backoff = 1
    r = None

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

            await _ensure_group_once(r, stream, group)

            log.info(f"Listening on Redis stream {stream} (group={group}, consumer={consumer})")
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

                for stream_name, messages in results:
                    for msg_id, fields in messages:
                        try:
                            text = fields.get("text", "")
                            user = fields.get("user_name") or fields.get("user", "?")
                            action = fields.get("action_hint", "respond")
                            if action == "ignore":
                                await r.xack(stream, group, msg_id)
                                continue
                            log.info(f"TG Redis msg from {user}: {text[:60]}")
                            _health["last_received_at"] = asyncio.get_running_loop().time()
                            await raw_queue.put({"source": "telegram", "data": fields})
                            await r.xack(stream, group, msg_id)
                        except Exception as e:
                            log.error(f"Error processing TG msg {msg_id}: {e}")

        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            log.warning(f"Redis watcher error: {e!r}, retrying in {backoff}s")
            _forget_group_if_missing(e, stream, group)
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


async def redis_reactions_watcher(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """Read a Redis reactions stream via consumer group.
    Requires cfg["reaction_stream"] = {"stream": ..., "group": ..., "consumer": ...}
    """
    try:
        import redis.asyncio as aioredis
    except ImportError:
        log.error("redis.asyncio not installed — redis-reactions source disabled")
        return

    rs_cfg   = cfg["reaction_stream"]
    stream   = rs_cfg["stream"]
    group    = rs_cfg["group"]
    consumer = rs_cfg["consumer"]

    backoff = 1
    r = None

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

            await _ensure_group_once(r, stream, group)

            log.info(f"Listening on Redis stream {stream} (group={group}, consumer={consumer})")
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

                for stream_name, messages in results:
                    for msg_id, fields in messages:
                        try:
                            user = fields.get("user", "?")
                            new_r = fields.get("new_reaction", "")
                            log.info(f"Reaction from {user}: {new_r}")
                            _health["last_received_at"] = asyncio.get_running_loop().time()
                            await raw_queue.put({"source": "reaction", "data": fields})
                            await r.xack(stream, group, msg_id)
                        except Exception as e:
                            log.error(f"Error processing reaction {msg_id}: {e}")

        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            log.warning(f"Reaction Redis watcher error: {e!r}, retrying in {backoff}s")
            _forget_group_if_missing(e, stream, group)
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ── GitHub Issues scanner ─────────────────────────────────────────────────────

async def github_issues_scanner(raw_queue: asyncio.Queue, cfg: dict) -> None:
    """Poll GitHub Issues every scan_interval seconds for new open bugs.
    Requires cfg["github"] = {"repo": ..., "scan_interval": ..., "labels": [...]}
    """
    if not GH_TOKEN:
        log.warning("GH_TOKEN not set — GitHub Issues scanning disabled")
        return

    gh_cfg        = cfg["github"]
    repo          = gh_cfg["repo"]
    scan_interval = gh_cfg.get("scan_interval", 900)
    labels        = gh_cfg.get("labels", ["bug"])
    agent_id      = cfg["agent_id"]

    env = {**os.environ, "GH_TOKEN": GH_TOKEN}
    last_seen_ids: set[int] = set()

    while True:
        try:
            found_new = False
            for label in labels:
                proc = await asyncio.create_subprocess_exec(
                    "gh", "issue", "list",
                    "--repo", repo,
                    "--state", "open",
                    "--label", label,
                    "--json", "number,title,labels,createdAt",
                    "--limit", "20",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=env,
                )
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
                issues = json.loads(stdout) if stdout else []

                new_issues = [i for i in issues if i["number"] not in last_seen_ids]
                if new_issues:
                    found_new = True
                    for issue in new_issues:
                        log.info(f"New GitHub issue #{issue['number']}: {issue['title']}")
                        await raw_queue.put({
                            "source": "github",
                            "data": {
                                "from": "github",
                                "text": f"{agent_id}:fix issue={issue['number']} title={issue['title']}",
                                "timestamp": issue.get("createdAt", ""),
                            }
                        })
                        last_seen_ids.add(issue["number"])

            if not found_new:
                await raw_queue.put({
                    "source": "github",
                    "data": {
                        "from": "github",
                        "text": f"{agent_id}:scan",
                        "timestamp": "",
                    }
                })

        except Exception as e:
            log.warning(f"GitHub scan error: {e!r}")

        await asyncio.sleep(scan_interval)
