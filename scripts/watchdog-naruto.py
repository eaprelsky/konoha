#!/usr/bin/env python3
"""
Watchdog for Naruto (Claude Agent #1).
Watches two sources in parallel:
  1. Redis stream telegram:bot:incoming  (consumer group naruto)
  2. Konoha SSE stream /messages/naruto/stream

When events arrive, batches them (2s debounce window) and sends to the
naruto tmux session only when the agent is idle (❯ prompt visible).

Special features not in watchdog_base:
  - L1 interrupt: Ctrl+C after 30s if owner message is pending (#320)
  - Adaptive paste_wait: longer wait for messages ≥800 chars (#288, #300)
  - TG delivery state: Redis ack only after tmux delivery
  - Konoha echo dedup: drops Konoha echoes of TG messages we already have
  - Multi-source format_batch (TG + Konoha + reactions)
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
import time
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b
import redis.asyncio as aioredis

# ── Config ───────────────────────────────────────────────────────────────────
_b.AGENT_ID          = "naruto"
_b.TMUX_SESSION      = "naruto"
_b.DEBOUNCE_WINDOW   = 2.0
_b.IDLE_TIMEOUT_SEC  = 600
_b.STARTUP_GRACE_SEC = 90     # give startup sequence time to read memory before backlog delivery
# No circuit breaker / wake-up — naruto is always running

REACTION_QUEUE  = Path(os.path.expanduser("~/.claude/channels/telegram/reaction-queue.jsonl"))

REDIS_HOST    = "127.0.0.1"
REDIS_PORT    = 6379
TG_STREAM     = "telegram:bot:incoming"
TG_GROUP      = "naruto"
TG_CONSUMER   = "naruto-watchdog"
STALE_PENDING_MAX_AGE_SEC = int(os.environ.get("NARUTO_STALE_PENDING_MAX_AGE_SEC", "600"))

L1_INTERRUPT_AFTER_SEC = 30   # interrupt agent with Ctrl+C if L1 (owner) message waits this long (#320)
OWNER_TG_ID = "93791246"      # Yegor Aprelsky — Level 1 trust
PASTE_DIALOG_THRESHOLD = 800  # chars below which no paste dialog expected


# ── L1 priority detection ─────────────────────────────────────────────────────

def has_l1_message(events: list[dict]) -> bool:
    """Return True if any pending event is from Level 1 (owner)."""
    for ev in events:
        if ev.get("source") == "telegram":
            d = ev.get("data", ev)
            if str(d.get("trust_level", "")) == "1" or str(d.get("user_id", "")) == OWNER_TG_ID:
                return True
    return False


# ── Adaptive tmux_send ────────────────────────────────────────────────────────
# Naruto receives long messages (TG + Konoha batches), so uses adaptive paste_wait.

async def tmux_send(session: str, text: str) -> bool:
    text = text.replace("\n", " ").replace("\r", " ")
    compacting_waited = 0
    while compacting_waited < 120:
        if not _b.is_session_alive(session):
            _b.log.error(f"Delivery failed: tmux session {session} is missing before send")
            return False
        if _b.is_agent_idle(session, stable_checks=1):
            break
        _b.log.info(f"Agent {session} compacting — waiting (waited {compacting_waited}s)")
        await asyncio.sleep(2.0)
        compacting_waited += 2
    if compacting_waited >= 120:
        _b.log.warning(f"Agent {session} still compacting after 120s — proceeding anyway")
    elif compacting_waited > 0:
        _b.log.info(f"Compacting done after {compacting_waited}s — proceeding")
        await asyncio.sleep(1.0)

    async def dismiss_pasted_dialog() -> None:
        for _ in range(5):
            if not _b.is_session_alive(session):
                return
            content = _b.tmux_pane_content(session)
            if "Pasted text" not in content:
                return
            _b.log.warning(f"[Pasted text] dialog detected in {session} — sending Enter")
            await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter")
            await asyncio.sleep(0.6)


    async def retype_prompt() -> bool:
        await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, "C-u", timeout=5.0)
        await asyncio.sleep(0.15)
        ok_local = await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, text, timeout=5.0)
        if not ok_local:
            _b.log.error(f"Retype timed out for {session}")
            return False
        await asyncio.sleep(paste_wait)
        await dismiss_pasted_dialog()
        return True

    async def wait_for_submit(timeout_sec: float) -> bool:
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            if not _b.is_session_alive(session):
                _b.log.error(f"Delivery failed: tmux session {session} disappeared during submit")
                return False
            content = _b.tmux_pane_content(session)
            if "Pasted text" in content:
                _b.log.warning(f"[Pasted text] dialog appeared after submit in {session} — sending Enter")
                await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter")
                await asyncio.sleep(0.6)
                continue
            if content.strip() and not _b.is_agent_idle(session, stable_checks=1):
                _b.log.info("Delivery confirmed: agent left idle state after submit")
                return True
            await asyncio.sleep(0.4)
        return False


    ok = await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, text, timeout=5.0)
    if not ok:
        _b.log.error(f"send-keys timed out for {session} — skipping delivery")
        return False

    if len(text) >= PASTE_DIALOG_THRESHOLD:
        paste_wait = max(1.5, min(len(text) / 3000.0, 3.0))
    else:
        paste_wait = 0.5
    await asyncio.sleep(paste_wait)
    await dismiss_pasted_dialog()

    for attempt in range(4):
        if attempt == 1:
            _b.log.warning("Agent stayed idle after submit attempt 1 — retrying Enter")
        elif attempt >= 2:
            _b.log.warning(f"Agent stayed idle after submit attempt {attempt} — clearing input and retyping prompt")
            if not await retype_prompt():
                return False

        await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter", timeout=5.0)
        _b.log.info(f"Sent prompt to {session} ({len(text)} chars), submit attempt {attempt + 1}")
        if await wait_for_submit(4.0 if attempt == 0 else 3.0):
            return True

    _b.log.error(f"Delivery failed: agent {session} stayed idle after submit retries")
    return False


# ── Message formatting (multi-source) ────────────────────────────────────────

def format_batch(events: list[dict]) -> str:
    """Convert a batch of events into a single prompt for the agent."""
    tg_events       = [e for e in events if e.get("source") == "telegram"]
    konoha_events   = [e for e in events if e.get("source") == "konoha"]
    reaction_events = [e for e in events if e.get("source") == "reaction"]

    # Deduplicate: Konoha TG-bridge echoes look like "[TG Sender] text"
    # If we already have the TG event directly, skip its Konoha echo
    tg_texts = {(ev.get("data", ev).get("text") or "").strip() for ev in tg_events}
    konoha_deduped = []
    for ev in konoha_events:
        d = ev.get("data", ev)
        konoha_text = (d.get("text") or "").strip()
        sender = d.get("from", "")
        if sender == "telegram":
            for tg_text in tg_texts:
                if tg_text and tg_text in konoha_text:
                    _b.log.info(f"Deduped Konoha echo of TG message: {konoha_text[:60]}")
                    break
            else:
                konoha_deduped.append(ev)
        else:
            konoha_deduped.append(ev)

    lines = []

    if tg_events:
        lines.append("Новые сообщения в Telegram:")
        for ev in tg_events:
            d = ev.get("data", ev)
            sender = d.get("user_name") or d.get("user", "?")
            text = d.get("text", "")
            ts = d.get("ts", "")[:16] if d.get("ts") else ""
            lines.append(f"\n[{ts}] {sender}: {text}")
        lines.append("\nОбработай и ответь через: python3 /home/ubuntu/naruto-tg-send.py <chat_id> \"<text>\" [reply_to].")

    if konoha_deduped:
        if lines:
            lines.append("")
        lines.append("Новые сообщения в шине Коноха:")
        for ev in konoha_deduped:
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
            emoji = d.get("new_reaction", "?")
            user = d.get("user", "?")
            msg_id = d.get("message_id", "?")
            ts = d.get("ts", "")[:16]
            lines.append(f"\n[{ts}] {user} поставил {emoji} на сообщение {msg_id}")
        lines.append("\nМожешь отреагировать через tg_react если нужно, или просто прими к сведению.")

    return "\n".join(lines)


# ── Custom send loop (L1 interrupt + Redis ack after delivery) ────────────────

def _stream_batch_has_messages(results: list) -> bool:
    """Return True only when XREADGROUP returned at least one message."""
    return any(messages for _stream_name, messages in results)


def _is_stale_pending_id(redis_id: str, *, now_ms: int | None = None) -> bool:
    """Return True for old pending stream IDs that should not be replayed."""
    try:
        created_ms = int(str(redis_id).split("-", 1)[0])
    except (TypeError, ValueError):
        return False
    current_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    return (current_ms - created_ms) > STALE_PENDING_MAX_AGE_SEC * 1000


async def _ack_telegram_events(events: list[dict], rd: aioredis.Redis) -> bool:
    """Ack delivered Telegram Redis events after they reached the agent."""
    ids = [ev.get("redis_id") for ev in events if ev.get("source") == "telegram" and ev.get("redis_id")]
    if not ids:
        return True
    try:
        await rd.xack(TG_STREAM, TG_GROUP, *ids)
        _b.log.info(f"Acked {len(ids)} Telegram event(s) after delivery")
        return True
    except Exception as e:
        _b.log.error(f"Failed to ack {len(ids)} Telegram event(s): {e}")
        return False

async def send_loop(batched_queue: asyncio.Queue) -> None:
    """Wait for idle, then flush the pending batch.
    Supports L1 (owner) interrupt and Redis ack-after-delivery.
    """
    pending: list[dict] = []
    rd = aioredis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

    while True:
        if pending and any(ev.get("_delivered_to_agent") for ev in pending):
            if await _ack_telegram_events(pending, rd):
                pending.clear()
            else:
                await asyncio.sleep(1.0)
            continue

        try:
            timeout = 1.0 if pending else None
            batch = await asyncio.wait_for(batched_queue.get(), timeout=timeout)
            pending.extend(batch)
        except asyncio.TimeoutError:
            pass

        if not pending:
            continue

        waited = 0.0
        while True:
            if _b.is_agent_idle(_b.TMUX_SESSION):
                break
            if waited >= _b.IDLE_TIMEOUT_SEC:
                _b.log.warning(f"Agent {_b.TMUX_SESSION} busy >{_b.IDLE_TIMEOUT_SEC}s — dropping {len(pending)} msgs")
                await _b.send_freeze_alert(_b.TMUX_SESSION, waited, len(pending))
                sys.exit(1)
            # L1 priority interrupt (#320): owner message waiting too long
            if waited >= L1_INTERRUPT_AFTER_SEC and has_l1_message(pending):
                _b.log.warning(f"L1 (owner) message pending {int(waited)}s — sending Ctrl+C to interrupt agent")
                await _b.tmux_run("tmux", "-L", _b.TMUX_SESSION, "send-keys", "-t", _b.TMUX_SESSION, "C-c", timeout=5.0)
                await asyncio.sleep(2.0)
                break
            await asyncio.sleep(_b.IDLE_POLL_SEC)
            waited += _b.IDLE_POLL_SEC

        if pending:
            try:
                prompt = format_batch(pending)
                delivered = await tmux_send(_b.TMUX_SESSION, prompt)
                if delivered is not False:
                    for ev in pending:
                        ev["_delivered_to_agent"] = True
                else:
                    _b.log.warning(f"tmux_send timed out — retrying {len(pending)} msg(s) on next idle")
            except Exception as e:
                _b.log.error(f"tmux send failed: {e}")
                await asyncio.sleep(1.0)


# ── Telegram Redis stream watcher ────────────────────────────────────────────

SEEN_REACTIONS_FILE = Path(f"/tmp/watchdog-naruto-seen-reactions.json")
MAX_SEEN_REACTIONS = 500


def _load_seen_reactions() -> set:
    if SEEN_REACTIONS_FILE.exists():
        try:
            return set(tuple(x) for x in json.loads(SEEN_REACTIONS_FILE.read_text()))
        except Exception:
            pass
    return set()


def _save_seen_reactions(seen: set) -> None:
    try:
        SEEN_REACTIONS_FILE.write_text(json.dumps(list(seen)))
    except Exception as e:
        _b.log.warning(f"Could not persist seen reactions: {e}")


async def telegram_redis_watcher(raw_queue: asyncio.Queue) -> None:
    """Read telegram:bot:incoming via Redis consumer group."""
    backoff = 1
    r = None
    replay_pending = True
    pending_replay_seen: set[str] = set()

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
                stream_id = "0" if replay_pending else ">"
                results = await r.xreadgroup(
                    TG_GROUP,
                    TG_CONSUMER,
                    {TG_STREAM: stream_id},
                    count=10,
                    block=100 if replay_pending else 5000,
                )
                if not _stream_batch_has_messages(results):
                    if replay_pending:
                        replay_pending = False
                        pending_replay_seen.clear()
                        _b.log.info(f"Pending replay drained for {TG_STREAM} ({TG_GROUP}/{TG_CONSUMER})")
                    continue

                emitted = False
                acked_stale = False
                for _stream_name, messages in results:
                    for msg_id, fields in messages:
                        if replay_pending:
                            if msg_id in pending_replay_seen:
                                continue
                            pending_replay_seen.add(msg_id)
                            if _is_stale_pending_id(msg_id):
                                await r.xack(TG_STREAM, TG_GROUP, msg_id)
                                acked_stale = True
                                _b.log.info(f"Acked stale pending Telegram event {msg_id}")
                                continue
                        try:
                            action = fields.get("action_hint", "respond")
                            if action == "ignore":
                                await r.xack(TG_STREAM, TG_GROUP, msg_id)
                                continue
                            _b.log.info(f"TG Redis msg from {fields.get('user','?')}: {fields.get('text','')[:60]}")
                            await raw_queue.put({"source": "telegram", "data": fields, "redis_id": msg_id})
                            emitted = True
                        except Exception as e:
                            _b.log.error(f"Error processing TG msg {msg_id}: {e}")
                if replay_pending and not emitted:
                    if acked_stale:
                        continue
                    replay_pending = False
                    pending_replay_seen.clear()
                    _b.log.info(f"Pending replay deduped/drained for {TG_STREAM} ({TG_GROUP}/{TG_CONSUMER})")
        except asyncio.CancelledError:
            if r:
                await r.aclose()
            raise
        except Exception as e:
            _b.log.warning(f"TG Redis watcher error: {e!r}, retrying in {backoff}s")
            if r:
                try:
                    await r.aclose()
                except Exception:
                    pass
            r = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


async def reaction_queue_watcher(raw_queue: asyncio.Queue) -> None:
    """Watch reaction-queue.jsonl and deliver new reactions, deduplicating by signature."""
    seen: set = _load_seen_reactions()

    if not seen and REACTION_QUEUE.exists():
        try:
            lines = REACTION_QUEUE.read_text().strip().splitlines()
            for line in lines:
                try:
                    r = json.loads(line)
                    sig = (str(r.get("message_id", "")), r.get("new_reaction", ""), r.get("user", ""))
                    seen.add(sig)
                except Exception:
                    pass
            _save_seen_reactions(seen)
            _b.log.info(f"Seeded seen reactions: {len(seen)} entries")
        except Exception as e:
            _b.log.warning(f"Could not seed seen reactions: {e}")

    while True:
        try:
            if not REACTION_QUEUE.exists():
                await asyncio.sleep(5)
                continue
            lines = REACTION_QUEUE.read_text().strip().splitlines()
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
                if len(seen) > MAX_SEEN_REACTIONS:
                    seen = set(list(seen)[-MAX_SEEN_REACTIONS:])
                _save_seen_reactions(seen)
                for r in new_reactions:
                    emoji = r.get("new_reaction", "?")
                    user = r.get("user", "?")
                    msg_id = r.get("message_id", "?")
                    _b.log.info(f"Reaction {emoji} from {user} on msg {msg_id}")
                    await raw_queue.put({"source": "reaction", "data": r})
            await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _b.log.warning(f"Reaction watcher error: {e!r}")
            await asyncio.sleep(5)


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
        reaction_queue_watcher(raw_queue),
        _b.debouncer(raw_queue, batched_queue),
        send_loop(batched_queue),
        _b.heartbeat_loop(),
    )


if __name__ == "__main__":
    asyncio.run(main())
