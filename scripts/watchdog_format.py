#!/usr/bin/env python3
"""
watchdog_format — message noise filter and multi-source batch formatting.

Extracted from watchdog.py (#573). Imported by watchdog.py.
"""

import logging

log = logging.getLogger(__name__)

# ── Noise filter ──────────────────────────────────────────────────────────────

NOISE_TEXT_PREFIXES = ("SESSION_ONLINE:", "SESSION_OFFLINE:", "SESSION_READY:")
NOISE_TEXT_CONTAINS = ("going offline (session end)",)


def is_session_noise(data: dict) -> bool:
    """Return True for SESSION_ONLINE/OFFLINE noise events that should be dropped."""
    text = data.get("text", "")
    return (
        any(text.startswith(p) for p in NOISE_TEXT_PREFIXES) or
        any(s in text for s in NOISE_TEXT_CONTAINS)
    )


# ── Delivery actionability ───────────────────────────────────────────────────

NON_WORK_TYPES = {"status", "result", "event"}
ACK_TEXT_MARKERS = (
    "duplicate review delivery ignored",
    "duplicate watchdog push delivery",
    "duplicate delivery",
    "already closed",
    "already accepted",
    "no new action needed",
)
WORK_TEXT_MARKERS = (
    "github:",
    "ready for dev:",
    "ready-for-dev",
    "state:ready-for-dev",
    "state:in-progress",
    "changes requested",
    "review blocked",
    "state:blocked",
    "next dispatch",
    "задание для",
)


def _field_value(text: str, field: str) -> str | None:
    import re

    match = re.search(rf"(?:^|\s){field}=([^\s]+)", text)
    return match.group(1).rstrip(",.;") if match else None


def classify_konoha_delivery(data: dict, agent_id: str = "") -> dict[str, str | bool]:
    """Classify whether a Konoha bus message should be injected into tmux.

    The watchdog is an execution surface, not a general event log. Status,
    audit, ack, and known healthcheck baseline messages remain available in
    Konoha history/channel streams, while actionable work and monitor incidents
    still reach the agent session.
    """
    text = str(data.get("text") or "")
    lowered = text.lower()
    msg_type = str(data.get("type") or "message").lower()
    sender = str(data.get("from") or "")

    if is_session_noise(data):
        return {"kind": "noise", "deliver": False, "reason": "session_lifecycle"}

    if text.startswith("kiba:healthcheck"):
        severity = _field_value(text, "severity") or "info"
        if severity == "incident":
            return {"kind": "work_item", "deliver": True, "reason": "monitor_incident_healthcheck"}
        return {"kind": "status", "deliver": False, "reason": f"healthcheck_{severity}"}

    if text.startswith("kiba:alert"):
        severity = _field_value(text, "severity")
        if severity in {"baseline", "warning-known", "info"}:
            return {"kind": "status", "deliver": False, "reason": f"monitor_{severity}"}
        if severity == "incident" or any(token in lowered for token in ("critical", "down", "timeout", "failed", "frozen", "stuck")):
            return {"kind": "work_item", "deliver": True, "reason": "monitor_incident"}

    if msg_type == "task":
        return {"kind": "work_item", "deliver": True, "reason": "type_task"}

    if any(marker in lowered for marker in WORK_TEXT_MARKERS):
        return {"kind": "work_item", "deliver": True, "reason": "work_marker"}

    if msg_type in NON_WORK_TYPES:
        return {"kind": "audit" if msg_type == "event" else msg_type, "deliver": False, "reason": f"type_{msg_type}"}

    if any(marker in lowered for marker in ACK_TEXT_MARKERS):
        return {"kind": "ack", "deliver": False, "reason": "ack_marker"}

    if sender.startswith("watchdog-") and ("desync detected" in lowered or "audit" in lowered):
        return {"kind": "audit", "deliver": False, "reason": "watchdog_audit"}

    return {"kind": "work_item", "deliver": True, "reason": "default_message"}


# ── Text sanitization ──────────────────────────────────────────────────────────

def sanitize_message_text(text: str) -> str:
    """Fix common text encoding issues before delivery:
    1. Convert literal \\n (two chars) to real newlines — prevents double-escaping
       in Telegram/JSON pipelines.
    2. Remove MarkdownV2 escape artifacts like \\! → ! — plain-text safe.
    """
    if not text:
        return text
    import re
    text = text.replace("\\n", "\n")
    text = re.sub(r"\\([!./\-_{}()#>+*=|~`])", r"\1", text)
    return text


# ── Message formatting ────────────────────────────────────────────────────────

def format_batch(events: list[dict], cfg: dict) -> str:
    """Convert a batch of events into a single prompt for the agent.

    For naruto and sasuke (sources include telegram/redis/reactions), uses rich
    multi-section formatting.  For all other agents, uses simple prefix/suffix
    wrapping defined in config.
    """
    agent_id = cfg["agent_id"]
    prefix   = cfg.get("message_prefix", "")
    suffix   = cfg.get("message_suffix", "")

    # Naruto: telegram-file + konoha-sse + reactions
    if "telegram-file" in cfg.get("sources", []) or "telegram-reactions-file" in cfg.get("sources", []):
        return _format_naruto_batch(events)

    # Sasuke: redis-stream + konoha-sse + redis-reactions
    if "redis-stream" in cfg.get("sources", []) or "redis-reactions" in cfg.get("sources", []):
        return _format_sasuke_batch(events)

    # Generic: prefix / event lines / suffix
    lines = []
    if prefix:
        lines.append(prefix)
    for ev in events:
        d = ev.get("data", ev)
        sender = d.get("from", "?")
        text   = d.get("text", "")
        ts     = d.get("timestamp", "")
        lines.append(f"[{ts[:16] if ts else ''}] {sender}: {text}")
    if suffix:
        lines.append(suffix)
    return " | ".join(lines)


def _format_naruto_batch(events: list[dict]) -> str:
    """Naruto-specific multi-source batch formatting."""
    tg_events       = [e for e in events if e.get("source") == "telegram"]
    konoha_events   = [e for e in events if e.get("source") == "konoha"]
    reaction_events = [e for e in events if e.get("source") == "reaction"]

    # Deduplicate: Konoha TG-bridge echoes look like "[TG Sender] text"
    tg_texts = {(ev.get("data", ev).get("text") or "").strip() for ev in tg_events}
    konoha_deduped = []
    for ev in konoha_events:
        d = ev.get("data", ev)
        konoha_text = (d.get("text") or "").strip()
        sender = d.get("from", "")
        if sender == "telegram":
            for tg_text in tg_texts:
                if tg_text and tg_text in konoha_text:
                    log.info(f"Deduped Konoha echo of TG message: {konoha_text[:60]}")
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


def _format_sasuke_batch(events: list[dict]) -> str:
    """Sasuke-specific multi-source batch formatting."""
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
