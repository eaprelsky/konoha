#!/usr/bin/env python3
"""
Reminder Service — автономный планировщик напоминалок.

Redis storage: HASH  reminder:{uuid}
Fields: user_id, chat_id, text, schedule (ISO datetime or cron), repeat, created_by

Konoha commands (from sasuke):
  reminder:add user_id=X chat_id=Y text=... schedule=ISO [repeat=daily|weekly|hourly]
  reminder:list user_id=X
  reminder:delete id=UUID

On fire: sends Konoha message to sasuke → sasuke:reminder user_id=X chat_id=Y text=Z
"""

import os
import sys
import uuid
import time
import json
import logging
import subprocess
import redis
import re
from datetime import datetime, timezone, timedelta
from croniter import croniter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [reminder] %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("reminder")

KONOHA_URL = os.environ.get("KONOHA_URL", "http://127.0.0.1:3200")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
TG_SEND = "/home/ubuntu/tg-send.py"

r = redis.Redis(decode_responses=True)


# ── Helpers ───────────────────────────────────────────────────────────────────

def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_schedule(schedule: str) -> datetime | None:
    """Parse ISO datetime or natural shorthand. Returns next fire time or None."""
    s = schedule.strip()
    # ISO datetime
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        pass
    # Natural shorthands: "+10m", "+1h", "+1d"
    m = re.match(r"^\+(\d+)(m|h|d)$", s)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        delta = {"m": timedelta(minutes=n), "h": timedelta(hours=n), "d": timedelta(days=n)}[unit]
        return now_utc() + delta
    # Cron expression — return next fire time
    try:
        itr = croniter(s, now_utc())
        return itr.get_next(datetime).replace(tzinfo=timezone.utc)
    except Exception:
        pass
    return None


def next_fire(rem: dict) -> datetime | None:
    """Calculate next fire time for a reminder."""
    schedule = rem.get("schedule", "")
    last_fired = rem.get("last_fired")
    repeat = rem.get("repeat", "")

    # Cron expression — always calculate from now
    try:
        croniter(schedule)  # valid cron?
        itr = croniter(schedule, now_utc())
        return itr.get_next(datetime).replace(tzinfo=timezone.utc)
    except Exception:
        pass

    # ISO datetime
    try:
        dt = datetime.fromisoformat(schedule)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)

        if not repeat:
            # One-shot: fire if not yet fired
            if not last_fired:
                return dt
            return None  # already fired

        # Repeating — advance by repeat interval
        base = dt
        if last_fired:
            base = datetime.fromisoformat(last_fired).replace(tzinfo=timezone.utc)
        delta_map = {
            "hourly": timedelta(hours=1),
            "daily": timedelta(days=1),
            "weekly": timedelta(weeks=1),
        }
        delta = delta_map.get(repeat)
        if delta:
            next_dt = base + delta
            return next_dt
        return None
    except ValueError:
        pass

    # Shorthand (+Nm/h/d) — treat as one-shot ISO after parsing
    return None


def send_reminder(rem: dict, rem_id: str):
    """Fire a reminder: send via Konoha to sasuke."""
    chat_id = rem.get("chat_id", "")
    text = rem.get("text", "")
    user_id = rem.get("user_id", "")

    log.info("Firing reminder %s for user %s chat %s", rem_id, user_id, chat_id)

    # Send via Konoha → sasuke handles delivery
    try:
        import urllib.request
        payload = json.dumps({
            "from": "reminder-service",
            "to": "sasuke",
            "type": "task",
            "text": f"sasuke:reminder user_id={user_id} chat_id={chat_id} text={text}",
        }).encode()
        req = urllib.request.Request(
            f"{KONOHA_URL}/messages",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {KONOHA_TOKEN}",
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        log.error("Konoha send failed: %s — falling back to tg-send.py", e)
        # Fallback: direct tg-send
        if chat_id and text:
            try:
                subprocess.run(
                    ["python3", TG_SEND, chat_id, text],
                    timeout=10, check=True
                )
            except Exception as e2:
                log.error("tg-send fallback failed: %s", e2)


def mark_fired(rem_id: str):
    r.hset(f"reminder:{rem_id}", "last_fired", now_utc().isoformat())


def delete_reminder(rem_id: str):
    r.delete(f"reminder:{rem_id}")
    log.info("Deleted reminder %s", rem_id)


# ── Konoha command handling ───────────────────────────────────────────────────

CONSUMER_GROUP = "reminder-service"
CONSUMER_NAME = "reminder-worker"
STREAM = "reminder:commands"


def ensure_consumer_group():
    try:
        r.xgroup_create(STREAM, CONSUMER_GROUP, id="0", mkstream=True)
    except redis.exceptions.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def parse_kv(text: str) -> dict:
    """Parse 'key=value key2=value with spaces' — value ends at next key= or EOL."""
    result = {}
    # Find all key= positions
    pattern = re.compile(r'(\w+)=')
    matches = list(pattern.finditer(text))
    for i, m in enumerate(matches):
        key = m.group(1)
        val_start = m.end()
        val_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        result[key] = text[val_start:val_end].strip()
    return result


def handle_command(msg_text: str):
    """Process a reminder:* command."""
    text = msg_text.strip()

    if text.startswith("reminder:add"):
        params = parse_kv(text[len("reminder:add"):].strip())
        user_id = params.get("user_id", "")
        chat_id = params.get("chat_id", "")
        rem_text = params.get("text", "")
        schedule = params.get("schedule", "")
        repeat = params.get("repeat", "")

        if not (user_id and chat_id and rem_text and schedule):
            log.warning("reminder:add missing required fields: %s", params)
            return

        # Validate schedule
        fire_time = parse_schedule(schedule)
        if fire_time is None:
            log.warning("reminder:add invalid schedule: %s", schedule)
            return

        rem_id = str(uuid.uuid4())[:8]
        r.hset(f"reminder:{rem_id}", mapping={
            "user_id": user_id,
            "chat_id": chat_id,
            "text": rem_text,
            "schedule": fire_time.isoformat(),
            "repeat": repeat,
            "created_by": "sasuke",
            "created_at": now_utc().isoformat(),
        })
        log.info("Created reminder %s for %s at %s", rem_id, user_id, fire_time)

        # Confirm to sasuke
        try:
            import urllib.request
            payload = json.dumps({
                "from": "reminder-service",
                "to": "sasuke",
                "type": "result",
                "text": f"reminder:created id={rem_id} schedule={fire_time.isoformat()} text={rem_text}",
            }).encode()
            req = urllib.request.Request(
                f"{KONOHA_URL}/messages",
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {KONOHA_TOKEN}",
                },
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            log.error("Confirm send failed: %s", e)

    elif text.startswith("reminder:list"):
        params = parse_kv(text[len("reminder:list"):].strip())
        user_id = params.get("user_id", "")
        keys = r.keys("reminder:*")
        items = []
        for k in sorted(keys):
            rem = r.hgetall(k)
            if user_id and rem.get("user_id") != user_id:
                continue
            rid = k.split(":", 1)[1]
            items.append(f"#{rid}: {rem.get('text','')} @ {rem.get('schedule','')} repeat={rem.get('repeat','no')}")
        reply = "Напоминалки:\n" + "\n".join(items) if items else "Нет напоминалок."
        try:
            import urllib.request
            payload = json.dumps({
                "from": "reminder-service",
                "to": "sasuke",
                "type": "result",
                "text": f"reminder:list user_id={user_id}\n{reply}",
            }).encode()
            req = urllib.request.Request(
                f"{KONOHA_URL}/messages",
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {KONOHA_TOKEN}",
                },
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            log.error("List reply failed: %s", e)

    elif text.startswith("reminder:delete"):
        params = parse_kv(text[len("reminder:delete"):].strip())
        rem_id = params.get("id", "")
        if rem_id and r.exists(f"reminder:{rem_id}"):
            delete_reminder(rem_id)
            log.info("Deleted reminder %s via command", rem_id)
        else:
            log.warning("reminder:delete: not found: %s", rem_id)


def poll_commands():
    """Read reminder:commands stream (consumer group)."""
    try:
        msgs = r.xreadgroup(
            CONSUMER_GROUP, CONSUMER_NAME, {STREAM: ">"}, count=10, block=30000
        )
    except redis.exceptions.ResponseError:
        return
    if not msgs:
        return
    for _stream, entries in msgs:
        for msg_id, fields in entries:
            text = fields.get("text", "")
            if text.startswith("reminder:"):
                handle_command(text)
            r.xack(STREAM, CONSUMER_GROUP, msg_id)


# ── Main loop ─────────────────────────────────────────────────────────────────

def check_reminders():
    keys = r.keys("reminder:*")
    now = now_utc()
    for k in keys:
        if not k.startswith("reminder:") or k == "reminder:commands":
            continue
        rem = r.hgetall(k)
        if not rem:
            continue
        rem_id = k.split(":", 1)[1]
        fire_time = next_fire(rem)
        if fire_time is None:
            continue
        if now >= fire_time:
            send_reminder(rem, rem_id)
            repeat = rem.get("repeat", "")
            if repeat:
                mark_fired(rem_id)
                # Advance schedule for non-cron repeats
                try:
                    croniter(rem.get("schedule", ""))
                except Exception:
                    # Not a cron — update schedule to next fire time
                    delta_map = {
                        "hourly": timedelta(hours=1),
                        "daily": timedelta(days=1),
                        "weekly": timedelta(weeks=1),
                    }
                    delta = delta_map.get(repeat)
                    if delta:
                        next_dt = fire_time + delta
                        r.hset(k, "schedule", next_dt.isoformat())
            else:
                delete_reminder(rem_id)


# ── Built-in cron reminders ───────────────────────────────────────────────────

BUILTIN_REMINDERS = [
    {
        "id": "builtin-daily-report",
        "schedule": "0 10 * * *",  # 10:00 UTC every day
        "action": "konoha",
        "to": "sasuke",
        "text": "sasuke:daily-report text=Отправь Егору статус сделок и лидов через Мирай",
    },
]

_builtin_last_fired: dict[str, datetime] = {}


def check_builtin_reminders():
    now = now_utc()
    for rem in BUILTIN_REMINDERS:
        rid = rem["id"]
        try:
            itr = croniter(rem["schedule"], now)
            # get_prev gives the most recent scheduled time that is <= now
            prev = itr.get_prev(datetime).replace(tzinfo=timezone.utc)
            last = _builtin_last_fired.get(rid)
            if last is None or prev > last:
                _builtin_last_fired[rid] = prev
                log.info("Firing built-in reminder: %s", rid)
                import urllib.request
                payload = json.dumps({
                    "from": "reminder-service",
                    "to": rem["to"],
                    "type": "task",
                    "text": rem["text"],
                }).encode()
                req = urllib.request.Request(
                    f"{KONOHA_URL}/messages",
                    data=payload,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {KONOHA_TOKEN}",
                    },
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            log.error("Built-in reminder %s error: %s", rid, e)


def main():
    log.info("Reminder service starting")
    ensure_consumer_group()

    while True:
        try:
            poll_commands()
            check_reminders()
            check_builtin_reminders()
        except Exception as e:
            log.error("Loop error: %s", e)
        time.sleep(60)


if __name__ == "__main__":
    main()
