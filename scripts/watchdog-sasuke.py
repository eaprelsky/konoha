#!/usr/bin/env python3
"""
Watchdog for Sasuke (Claude Agent #2).
Watches two sources in parallel:
  1. Redis stream telegram:incoming  (consumer group sasuke, consumer sasuke-watchdog)
  2. Konoha SSE stream /messages/sasuke/stream

When events arrive, batches them (2s debounce window) and sends to the
sasuke tmux session only when the agent is idle (❯ prompt visible).

Special features not in watchdog_base:
  - mark_read: sends telegram:commands after delivering TG messages
  - Health monitor: detects stuck delivery and restarts watchdog (#54, #148)
  - Multi-source format_batch (TG + Konoha + reactions with chat metadata)
  - Redis consumer group for TG stream (vs file polling used by naruto)
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b
import redis.asyncio as aioredis

# ── Config ───────────────────────────────────────────────────────────────────
_b.AGENT_ID          = "sasuke"
_b.TMUX_SESSION      = "sasuke"
_b.DEBOUNCE_WINDOW   = 2.0
_b.IDLE_TIMEOUT_SEC  = 600
# No circuit breaker / wake-up — sasuke is always running

REDIS_HOST    = "127.0.0.1"
REDIS_PORT    = 6379
TG_STREAM     = "telegram:incoming"
TG_GROUP      = "sasuke"
TG_CONSUMER   = "sasuke-watchdog"  # separate consumer so /loop fallback still works

REACTION_STREAM   = "telegram:reaction_updates"
REACTION_GROUP    = "sasuke-reactions"
REACTION_CONSUMER = "sasuke-reaction-watchdog"

HEALTH_STUCK_TIMEOUT = 720  # seconds: must be > IDLE_TIMEOUT_SEC (600) + buffer (#54, #148)

_health: dict = {
    "last_received_at": 0.0,
    "last_delivered_at": 0.0,
}


# ── Message formatting (multi-source with chat metadata) ─────────────────────

def format_batch(events: list[dict]) -> str:
    """Convert a batch of events into a single prompt for the agent."""
    tg_events       = [e for e in events if e.get("source") == "telegram"]
    konoha_events   = [e for e in events if e.get("source") == "konoha"]
    reaction_events = [e for e in events if e.get("source") == "reaction"]

    lines = []

    if tg_events:
        lines.append("Новые сообщения в Telegram:")
        for ev in tg_events:
            d = ev.get("data", ev)
            sender = (d.get("sender_name") or d.get("sender_username")
                      or d.get("user_name") or d.get("user", "?"))
            text = d.get("text", "")
            ts = (d.get("ts") or d.get("timestamp", ""))[:16]
            chat_id = d.get("chat_id", "")
            chat_title = d.get("chat_title", "")
            is_group = d.get("is_group", "0")
            msg_id = d.get("msg_id", "")
            sender_id = d.get("sender_id", "")
            meta = f"chat_id={chat_id}"
            if chat_title:
                meta += f" [{chat_title}]"
            if is_group in ("1", 1, True):
                meta += " [group]"
            if sender_id:
                meta += f" sender_id={sender_id}"
            if msg_id:
                meta += f" msg_id={msg_id}"
            attachment_path = d.get("attachment_path", "")
            attachment_kind = d.get("attachment_kind", "")
            lines.append(f"\n[{ts}] {sender} ({meta}): {text}")
            if attachment_path:
                lines.append(f"  [Вложение: {attachment_kind} — {attachment_path}]")
        lines.append("\nОбработай и при необходимости ответь через tg-send-user.py.")

    if konoha_events:
        if lines:
            lines.append("")
        lines.append("Новые сообщения в шине Коноха:")
        for ev in konoha_events:
            d = ev.get("data", ev)
            sender = d.get("from", "?")
            text = d.get("text", "")
            ts = d.get("timestamp", "")
            if len(text) > _b.KONOHA_TEXT_LIMIT:
                _b.log.warning(f"Konoha message from {sender} truncated: {len(text)} chars → {_b.KONOHA_TEXT_LIMIT}")
                text = text[:_b.KONOHA_TEXT_LIMIT] + f"... [сообщение обрезано: {len(d.get('text',''))} символов — вызови konoha_read для полного текста]"
            lines.append(f"\n[{ts[:16] if ts else ''}] {sender}: {text}")
        lines.append("\nОбработай и при необходимости ответь через konoha_send.")

    if reaction_events:
        if lines:
            lines.append("")
        lines.append("Новые реакции в Telegram:")
        for ev in reaction_events:
            d = ev.get("data", ev)
            user = d.get("user", "?")
            new_r = d.get("new_reaction", "")
            old_r = d.get("old_reaction", "")
            msg_id = d.get("message_id", "")
            chat_id = d.get("chat_id", "")
            lines.append(f"  {user} поставил {new_r} (было: {old_r}) на сообщение {msg_id} в чате {chat_id}")
        lines.append("Учти реакции как обратную связь.")

    return "\n".join(lines)


# ── Custom send loop (mark_read + health tracking) ────────────────────────────

async def _mark_read_telegram(events: list[dict], rd: aioredis.Redis) -> None:
    """Send mark_read to telegram:commands for each Telegram message in the batch."""
    import time as _time
    for ev in events:
        if ev.get("source") != "telegram":
            continue
        d = ev.get("data", {})
        chat_id = d.get("chat_id", "")
        msg_id = d.get("msg_id", "")
        if not chat_id or not msg_id:
            continue
        try:
            await rd.xadd("telegram:commands", {
                "command": "mark_read",
                "chat_id": chat_id,
                "msg_id": msg_id,
                "request_id": f"wr-{int(_time.time())}",
            })
            _b.log.info(f"mark_read sent for chat_id={chat_id} msg_id={msg_id}")
        except Exception as e:
            _b.log.warning(f"Failed to send mark_read for {chat_id}/{msg_id}: {e}")


async def send_loop(batched_queue: asyncio.Queue) -> None:
    """Wait for idle, then flush the pending batch.
    Sends mark_read to Redis after delivery and tracks health state.
    """
    pending: list[dict] = []
    rd = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

    while True:
        try:
            timeout = 1.0 if pending else None
            batch = await asyncio.wait_for(batched_queue.get(), timeout=timeout)
            pending.extend(batch)
        except asyncio.TimeoutError:
            pass

        if not pending:
            continue

        waited = 0.0
        grace_deadline = 0.0
        while True:
            if _b.is_agent_idle(_b.TMUX_SESSION):
                break
            now = asyncio.get_running_loop().time()
            if grace_deadline > now:
                await asyncio.sleep(min(_b.IDLE_POLL_SEC, max(0.2, grace_deadline - now)))
                continue
            if grace_deadline > 0.0:
                _b.log.info(f"Startup grace elapsed for {_b.TMUX_SESSION} — resuming desync timer")
                grace_deadline = 0.0
                waited = 0.0
            if waited >= _b.IDLE_TIMEOUT_SEC:
                _b.log.warning(
                    f"Agent {_b.TMUX_SESSION} busy >{_b.IDLE_TIMEOUT_SEC}s — attempting desync recovery (#505)"
                )
                await _b._send_desync_audit("agent unresponsive", f"waited={waited:.0f}s msgs={len(pending)}")
                recovered = await _b.try_desync_recovery()
                if recovered:
                    _b.log.info(f"Desync recovery succeeded — retrying delivery of {len(pending)} msg(s)")
                    waited = 0.0
                    grace_deadline = max(
                        grace_deadline,
                        asyncio.get_running_loop().time() + _b.DESYNC_RECOVERY_GRACE_SEC,
                    )
                    continue
                _b.log.warning(f"Desync recovery failed — dropping {len(pending)} msgs")
                await _b.send_freeze_alert(_b.TMUX_SESSION, waited, len(pending))
                pending.clear()
                break
            await asyncio.sleep(_b.IDLE_POLL_SEC)
            waited += _b.IDLE_POLL_SEC

        if pending:
            try:
                prompt = format_batch(pending)
                await _b.tmux_send(_b.TMUX_SESSION, prompt)
                _health["last_delivered_at"] = asyncio.get_running_loop().time()
                await _mark_read_telegram(pending, rd)
            except Exception as e:
                _b.log.error(f"tmux send failed: {e}")
            pending.clear()


# ── Redis stream watchers ─────────────────────────────────────────────────────

async def telegram_redis_watcher(raw_queue: asyncio.Queue) -> None:
    """
    Read telegram:incoming Redis stream via consumer group.
    Uses a separate consumer name so the /loop fallback (sasuke-worker) still works.
    """
    backoff = 1
    r = None

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

            try:
                await r.xgroup_create(TG_STREAM, TG_GROUP, id="$", mkstream=True)
                _b.log.info(f"Created consumer group {TG_GROUP} on {TG_STREAM}")
            except Exception as e:
                if "BUSYGROUP" not in str(e):
                    raise

            _b.log.info(f"Listening on Redis stream {TG_STREAM} (group={TG_GROUP}, consumer={TG_CONSUMER})")
            backoff = 1

            while True:
                results = await r.xreadgroup(
                    TG_GROUP, TG_CONSUMER,
                    {TG_STREAM: ">"},
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
                                await r.xack(TG_STREAM, TG_GROUP, msg_id)
                                continue
                            _b.log.info(f"TG Redis msg from {user}: {text[:60]}")
                            _health["last_received_at"] = asyncio.get_running_loop().time()
                            await raw_queue.put({"source": "telegram", "data": fields})
                            await r.xack(TG_STREAM, TG_GROUP, msg_id)
                        except Exception as e:
                            _b.log.error(f"Error processing TG msg {msg_id}: {e}")

        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            _b.log.warning(f"Redis watcher error: {e!r}, retrying in {backoff}s")
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


async def reaction_redis_watcher(raw_queue: asyncio.Queue) -> None:
    """Read telegram:reaction_updates Redis stream via consumer group."""
    backoff = 1
    r = None

    while True:
        try:
            if r is None:
                r = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

            try:
                await r.xgroup_create(REACTION_STREAM, REACTION_GROUP, id="$", mkstream=True)
                _b.log.info(f"Created consumer group {REACTION_GROUP} on {REACTION_STREAM}")
            except Exception as e:
                if "BUSYGROUP" not in str(e):
                    raise

            _b.log.info(f"Listening on {REACTION_STREAM} (group={REACTION_GROUP})")
            backoff = 1

            while True:
                results = await r.xreadgroup(
                    REACTION_GROUP, REACTION_CONSUMER,
                    {REACTION_STREAM: ">"},
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
                            _b.log.info(f"Reaction from {user}: {new_r}")
                            _health["last_received_at"] = asyncio.get_running_loop().time()
                            await raw_queue.put({"source": "reaction", "data": fields})
                            await r.xack(REACTION_STREAM, REACTION_GROUP, msg_id)
                        except Exception as e:
                            _b.log.error(f"Error processing reaction {msg_id}: {e}")

        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            _b.log.warning(f"Reaction watcher error: {e!r}, retrying in {backoff}s")
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ── Health monitor ────────────────────────────────────────────────────────────

async def health_monitor() -> None:
    """
    Detects stuck delivery: if a message was received but not delivered within
    HEALTH_STUCK_TIMEOUT seconds, log error and exit (systemd Restart=always restarts).
    """
    await asyncio.sleep(30)  # grace period on startup
    while True:
        await asyncio.sleep(30)
        now = asyncio.get_running_loop().time()
        last_rx = _health["last_received_at"]
        last_tx = _health["last_delivered_at"]
        if last_rx > 0 and (now - last_rx) > HEALTH_STUCK_TIMEOUT and last_tx < last_rx:
            _b.log.error(
                f"Health monitor: message received {now - last_rx:.0f}s ago but not delivered "
                f"(last_rx={last_rx:.0f}, last_tx={last_tx:.0f}) — restarting watchdog"
            )
            sys.exit(1)


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    if not _b.KONOHA_TOKEN:
        raise RuntimeError("KONOHA_TOKEN env var not set")

    _b.setup_logging()
    _b.log.info(f"Watchdog starting for agent={_b.AGENT_ID}, session={_b.TMUX_SESSION}")

    raw_queue     = asyncio.Queue()
    batched_queue = asyncio.Queue()

    await asyncio.gather(
        _b.konoha_sse_watcher(raw_queue),
        telegram_redis_watcher(raw_queue),
        reaction_redis_watcher(raw_queue),
        _b.debouncer(raw_queue, batched_queue),
        send_loop(batched_queue),
        _b.heartbeat_loop(),
        health_monitor(),
    )


if __name__ == "__main__":
    asyncio.run(main())
