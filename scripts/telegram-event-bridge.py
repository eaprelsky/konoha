#!/usr/bin/env python3
"""Publish raw Telegram stream entries as generic Konoha events.

This adapter intentionally contains no business routing logic. Workflow
definitions decide what to do with `telegram.message.received` events.
"""
from __future__ import annotations

import json
import os
import signal
from typing import Any
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

import redis

REDIS_HOST = os.environ.get("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
STREAM = os.environ.get("TELEGRAM_EVENT_STREAM", "telegram:log")
GROUP = os.environ.get("TELEGRAM_EVENT_GROUP", "event-bridge")
CONSUMER = os.environ.get("TELEGRAM_EVENT_CONSUMER", "event-bridge-1")
AUDIT_STREAM = os.environ.get("TELEGRAM_EVENT_AUDIT_STREAM", "telegram:event_bridge:audit")
DEAD_STREAM = os.environ.get("TELEGRAM_EVENT_DEAD_STREAM", "telegram:event_bridge:dead_letter")
KONOHA_URL = os.environ.get("KONOHA_INTERNAL_URL", f"http://127.0.0.1:{os.environ.get('KONOHA_PORT', '3200')}")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
VILLAGE_ID = os.environ.get("KONOHA_VILLAGE_ID", "comind.konoha")
BLOCK_MS = int(os.environ.get("TELEGRAM_EVENT_BLOCK_MS", "5000"))

STOP = False


def _stop(_signum: int, _frame: object) -> None:
    global STOP
    STOP = True


def decode_fields(raw: dict[Any, Any]) -> dict[str, str]:
    return {str(k): str(v) for k, v in raw.items()}


def event_type(fields: dict[str, str]) -> str:
    if fields.get("new_reaction") or fields.get("old_reaction"):
        return "telegram.reaction.received"
    return "telegram.message.received"


def event_payload(entry_id: str, fields: dict[str, str]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        **fields,
        "telegram_stream": STREAM,
        "telegram_stream_id": entry_id,
    }
    if "text" in payload and payload["text"] is None:
        payload["text"] = ""
    return payload


def publish_event(entry_id: str, fields: dict[str, str]) -> dict[str, Any]:
    if not KONOHA_TOKEN:
        raise RuntimeError("KONOHA_TOKEN is not set")

    body = json.dumps({
        "type": event_type(fields),
        "source": "telegram",
        "payload": event_payload(entry_id, fields),
        "village_id": VILLAGE_ID,
    }, ensure_ascii=False).encode("utf-8")
    req = urlrequest.Request(
        f"{KONOHA_URL.rstrip('/')}/events",
        data=body,
        headers={"Authorization": f"Bearer {KONOHA_TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def ensure_group(r: redis.Redis) -> None:
    try:
        r.xgroup_create(STREAM, GROUP, id="$", mkstream=True)
    except redis.ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def process_entry(r: redis.Redis, entry_id: str, fields: dict[str, str]) -> None:
    audit: dict[str, str] = {
        "original_id": entry_id,
        "event_type": event_type(fields),
        "chat_id": fields.get("chat_id", ""),
        "chat_title": fields.get("chat_title", ""),
        "msg_id": fields.get("msg_id", ""),
    }
    try:
        result = publish_event(entry_id, fields)
        audit["result"] = "published"
        audit["event_id"] = str(result.get("id", ""))
        audit["cases_created"] = json.dumps(result.get("cases_created", []), ensure_ascii=False)
        r.xadd(AUDIT_STREAM, audit, maxlen=5000, approximate=True)
        r.xack(STREAM, GROUP, entry_id)
    except (HTTPError, URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        audit["result"] = "error"
        audit["error"] = f"{type(exc).__name__}: {str(exc)[:500]}"
        r.xadd(DEAD_STREAM, audit, maxlen=1000, approximate=True)
        r.xack(STREAM, GROUP, entry_id)
        raise


def main() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    ensure_group(r)
    while not STOP:
        items = r.xreadgroup(GROUP, CONSUMER, {STREAM: ">"}, count=10, block=BLOCK_MS)
        for _stream, messages in items:
            for entry_id, raw in messages:
                try:
                    process_entry(r, entry_id, decode_fields(raw))
                except Exception as exc:  # noqa: BLE001 - keep bridge alive.
                    print(f"ERR {entry_id}: {type(exc).__name__}: {str(exc)[:160]}", flush=True)
    r.close()


if __name__ == "__main__":
    main()
