#!/usr/bin/env python3
"""
Watchdog for Naruto (Claude Agent #1).
Watches two sources in parallel:
  1. ~/.claude/channels/telegram/message-queue.jsonl  (tail -F)
  2. Konoha SSE stream /messages/naruto/stream

When events arrive, batches them (2s debounce window) and sends to the
naruto tmux session only when the agent is idle (❯ prompt visible).

Special features not in watchdog_base:
  - L1 interrupt: Ctrl+C after 30s if owner message is pending (#320)
  - Adaptive paste_wait: longer wait for messages ≥800 chars (#288, #300)
  - TG delivery state: persists last_delivered_id for at-least-once delivery (#318)
  - Konoha echo dedup: drops Konoha echoes of TG messages we already have
  - Multi-source format_batch (TG + Konoha + reactions)
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
import watchdog_base as _b

# ── Config ───────────────────────────────────────────────────────────────────
_b.AGENT_ID          = "naruto"
_b.TMUX_SESSION      = "naruto"
_b.DEBOUNCE_WINDOW   = 2.0
_b.IDLE_TIMEOUT_SEC  = 600
_b.STARTUP_GRACE_SEC = 90     # give startup sequence time to read memory before backlog delivery
# No circuit breaker / wake-up — naruto is always running

MESSAGE_QUEUE   = Path(os.path.expanduser("~/.claude/channels/telegram/message-queue.jsonl"))
REACTION_QUEUE  = Path(os.path.expanduser("~/.claude/channels/telegram/reaction-queue.jsonl"))

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

    content_before = _b.tmux_pane_content(session)
    ok = await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, text, timeout=5.0)
    if not ok:
        _b.log.error(f"send-keys timed out for {session} — skipping delivery")
        return False

    # Adaptive paste_wait — dialog appears only for longer inputs (#288, #300)
    if len(text) >= PASTE_DIALOG_THRESHOLD:
        paste_wait = max(1.5, min(len(text) / 3000.0, 3.0))
    else:
        paste_wait = 0.5
    await asyncio.sleep(paste_wait)

    for _ in range(5):
        content = _b.tmux_pane_content(session)
        if "Pasted text" in content:
            _b.log.warning(f"[Pasted text] dialog detected in {session} — sending Enter to dismiss")
            await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter")
            await asyncio.sleep(paste_wait)
        else:
            break
    await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter", timeout=5.0)
    _b.log.info(f"Sent prompt to {session} ({len(text)} chars)")
    await asyncio.sleep(2.0)
    for attempt in range(3):
        content_after = _b.tmux_pane_content(session)
        if content_after != content_before:
            _b.log.info("Delivery confirmed: pane content changed after send")
            break
        if not _b.is_agent_idle(session, stable_checks=2):
            break
        _b.log.warning(f"Pane unchanged and agent idle (attempt {attempt+1}), resending")
        await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, "C-u", timeout=5.0)
        ok = await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, text, timeout=5.0)
        if not ok:
            _b.log.error(f"Resend attempt {attempt+1} timed out for {session}")
            break
        await asyncio.sleep(paste_wait)
        for _ in range(5):
            retry_content = _b.tmux_pane_content(session)
            if "Pasted text" in retry_content:
                await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter")
                await asyncio.sleep(paste_wait)
            else:
                break
        await _b.tmux_run("tmux", "-L", session, "send-keys", "-t", session, "Enter", timeout=5.0)
        await asyncio.sleep(2.0)
    return True


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
        lines.append("\nОбработай и ответь через naruto-tg-send.py.")

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


# ── Custom send loop (L1 interrupt + TG delivery state) ───────────────────────

async def send_loop(batched_queue: asyncio.Queue, tg_delivery_state: dict) -> None:
    """Wait for idle, then flush the pending batch.
    Supports L1 (owner) interrupt (#320) and persists last_delivered_id (#318).
    """
    pending: list[dict] = []
    delivered_id_file = Path(f"/tmp/watchdog-{_b.AGENT_ID}-last-tg-delivered")

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
        while True:
            if _b.is_agent_idle(_b.TMUX_SESSION):
                break
            if waited >= _b.IDLE_TIMEOUT_SEC:
                _b.log.warning(f"Agent {_b.TMUX_SESSION} busy >{_b.IDLE_TIMEOUT_SEC}s — dropping {len(pending)} msgs")
                await _b.send_freeze_alert(_b.TMUX_SESSION, waited, len(pending))
                pending.clear()
                break
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
                    pending.clear()
                    last_seen = tg_delivery_state.get("last_seen_id", 0)
                    if last_seen > 0:
                        try:
                            delivered_id_file.write_text(str(last_seen))
                            _b.log.debug(f"Confirmed delivery: last_tg_delivered={last_seen}")
                        except Exception as e:
                            _b.log.warning(f"Could not write delivered_id: {e}")
                else:
                    _b.log.warning(f"tmux_send timed out — retrying {len(pending)} msg(s) on next idle")
            except Exception as e:
                _b.log.error(f"tmux send failed: {e}")
                pending.clear()


# ── Telegram message-queue.jsonl watcher ─────────────────────────────────────

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


async def telegram_queue_watcher(raw_queue: asyncio.Queue, tg_delivery_state: dict) -> None:
    """
    Tail message-queue.jsonl and emit new messages.
    Tracks last_delivered_id for at-least-once delivery on restart (#318).
    """
    seen_id_file      = Path(f"/tmp/watchdog-{_b.AGENT_ID}-last-tg-id")
    delivered_id_file = Path(f"/tmp/watchdog-{_b.AGENT_ID}-last-tg-delivered")

    def _read_id(path: Path) -> int:
        if path.exists():
            try:
                return int(path.read_text().strip())
            except Exception:
                pass
        return 0

    last_id = _read_id(delivered_id_file)
    if last_id == 0:
        last_id = _read_id(seen_id_file)

    if last_id == 0 and MESSAGE_QUEUE.exists():
        try:
            lines = MESSAGE_QUEUE.read_text().strip().splitlines()
            if lines:
                last_line = json.loads(lines[-1])
                last_id = int(last_line.get("message_id", 0))
                seen_id_file.write_text(str(last_id))
                delivered_id_file.write_text(str(last_id))
                _b.log.info(f"Seeded last Telegram message_id={last_id} (first run)")
        except Exception as e:
            _b.log.warning(f"Could not seed last_id: {e}")

    tg_delivery_state["last_seen_id"] = last_id
    _b.log.info(f"Watching {MESSAGE_QUEUE}, last_delivered_id={last_id}")

    backoff = 1
    while True:
        try:
            if not MESSAGE_QUEUE.exists():
                await asyncio.sleep(5)
                continue
            lines = MESSAGE_QUEUE.read_text().strip().splitlines()
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
                seen_id_file.write_text(str(last_id))
                tg_delivery_state["last_seen_id"] = last_id
                for msg in new_events:
                    _b.log.info(f"TG message from {msg.get('user','?')}: {msg.get('text','')[:60]}")
                    await raw_queue.put({"source": "telegram", "data": msg})
            backoff = 1
            await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _b.log.warning(f"TG watcher error: {e!r}, retrying in {backoff}s")
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
    tg_delivery_state: dict = {"last_seen_id": 0}

    await asyncio.gather(
        _b.konoha_sse_watcher(raw_queue),
        telegram_queue_watcher(raw_queue, tg_delivery_state),
        reaction_queue_watcher(raw_queue),
        _b.debouncer(raw_queue, batched_queue),
        send_loop(batched_queue, tg_delivery_state),
        _b.heartbeat_loop(),
    )


if __name__ == "__main__":
    asyncio.run(main())
