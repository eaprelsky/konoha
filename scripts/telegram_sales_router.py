#!/usr/bin/env python3
"""Route Telegram lead signals into the Sales Lead Intake workflow."""
from __future__ import annotations

import hashlib
import json
import os
import signal
import time
from typing import Any
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

import redis

REDIS_HOST = os.environ.get("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
STREAM = os.environ.get("TELEGRAM_SALES_STREAM", "telegram:log")
GROUP = os.environ.get("TELEGRAM_SALES_GROUP", "sales-router")
CONSUMER = os.environ.get("TELEGRAM_SALES_CONSUMER", "sales-router-1")
AUDIT_STREAM = os.environ.get("TELEGRAM_SALES_AUDIT_STREAM", "telegram:sales_router:audit")
DEAD_STREAM = os.environ.get("TELEGRAM_SALES_DEAD_STREAM", "telegram:sales_router:dead_letter")
WORKFLOW_ID = os.environ.get("TELEGRAM_SALES_WORKFLOW_ID", "lead-qualification")
KONOHA_URL = os.environ.get("KONOHA_INTERNAL_URL", f"http://127.0.0.1:{os.environ.get('KONOHA_PORT', '3000')}")
KONOHA_TOKEN = os.environ.get("KONOHA_TOKEN", "")
SALES_CHAT_IDS = {
    item.strip()
    for item in os.environ.get("TELEGRAM_SALES_CHAT_IDS", "-4982206077").split(",")
    if item.strip()
}
BLOCK_SECONDS = int(os.environ.get("TELEGRAM_SALES_BLOCK_MS", "5000"))

STOP = False

SALES_KEYWORDS = (
    "lead", "лид", "заявк", "клиент", "кп", "коммерчес", "предложен", "proposal",
    "estimate", "оцен", "бюджет", "стоим", "проект", "хочет", "нужен", "нужно",
    "запрос", "воронк", "сделк", "crm", "битрикс", "bitrix", "discovery",
)

NOISE_KEYWORDS = (
    "спам", "реклама", "привет", "доброе утро", "ок", "спасибо", "понял", "👍",
)


def _stop(_signum: int, _frame: object) -> None:
    global STOP
    STOP = True


def decode_fields(raw: dict[Any, Any]) -> dict[str, str]:
    return {str(k): str(v) for k, v in raw.items()}


def classify_sales_event(event: dict[str, str]) -> dict[str, str]:
    """Classify a Telegram router event for sales workflow intake."""
    route = event.get("router_route", "").strip().lower()
    action = event.get("action_hint", "").strip().lower()
    text = event.get("text", "").strip()
    lowered = text.lower()
    chat_id = event.get("chat_id", "").strip()
    chat_title = event.get("chat_title", "").strip().lower()

    if route == "lead" and action in {"respond", "needs_context", "observe", ""}:
        return {"classification": "sales_lead", "reason": "router_route:lead"}

    in_sales_chat = chat_id in SALES_CHAT_IDS or "comind лид" in chat_title
    if in_sales_chat and any(keyword in lowered for keyword in SALES_KEYWORDS):
        return {"classification": "sales_lead", "reason": "sales_chat_keyword"}

    if any(keyword in lowered for keyword in NOISE_KEYWORDS) and len(lowered) < 80:
        return {"classification": "noise", "reason": "noise_keyword"}

    if in_sales_chat and text:
        return {"classification": "unknown", "reason": "sales_chat_unknown"}

    return {"classification": "not_sales", "reason": "no_sales_signal"}


def dedup_key(event: dict[str, str]) -> str:
    chat_id = event.get("chat_id", "")
    msg_id = event.get("msg_id", "") or event.get("_msg_id", "")
    if msg_id:
        return f"konoha:sales-router:routed:{chat_id}:{msg_id}"
    digest = hashlib.sha256(
        f"{chat_id}|{event.get('sender_id', '')}|{event.get('text', '')[:300]}".encode("utf-8")
    ).hexdigest()[:16]
    return f"konoha:sales-router:routed:{chat_id}:{digest}"


def build_case_args(event: dict[str, str], classification: dict[str, str]) -> dict[str, Any]:
    sender = event.get("sender_name") or event.get("sender_username") or event.get("sender_id") or "unknown"
    text = event.get("text", "").strip()
    subject_base = text.replace("\n", " ")[:80] or "Telegram sales lead"
    return {
        "process_id": WORKFLOW_ID,
        "subject": f"Telegram lead: {subject_base}",
        "payload": {
            "source": "telegram",
            "source_chat_id": event.get("chat_id", ""),
            "source_chat": event.get("chat_title", ""),
            "source_msg_id": event.get("msg_id", ""),
            "source_sender_id": event.get("sender_id", ""),
            "source_sender": sender,
            "source_agent": "sasuke",
            "raw_message": text,
            "router_route": event.get("router_route", ""),
            "router_confidence": event.get("router_confidence", ""),
            "router_reason": event.get("router_reason", ""),
            "sales_classification": classification["classification"],
            "sales_classification_reason": classification["reason"],
        },
    }


def start_sales_case(args: dict[str, Any]) -> dict[str, Any]:
    if not KONOHA_TOKEN:
        raise RuntimeError("KONOHA_TOKEN is not set")
    body = json.dumps({"action": "case.start", "category": "act", "args": args}, ensure_ascii=False).encode("utf-8")
    req = urlrequest.Request(
        f"{KONOHA_URL.rstrip('/')}/act",
        data=body,
        headers={"Authorization": f"Bearer {KONOHA_TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    if not result.get("ok"):
        raise RuntimeError(str(result.get("error") or "case.start failed"))
    return result


def ensure_group(r: redis.Redis) -> None:
    try:
        r.xgroup_create(STREAM, GROUP, id="$", mkstream=True)
    except redis.ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def process_event(r: redis.Redis, entry_id: str, event: dict[str, str]) -> None:
    classification = classify_sales_event(event)
    audit: dict[str, str] = {
        "original_id": entry_id,
        "chat_id": event.get("chat_id", ""),
        "msg_id": event.get("msg_id", ""),
        "classification": classification["classification"],
        "reason": classification["reason"],
        "router_route": event.get("router_route", ""),
        "router_confidence": event.get("router_confidence", ""),
    }

    if classification["classification"] != "sales_lead":
        r.xadd(AUDIT_STREAM, audit, maxlen=5000, approximate=True)
        r.xack(STREAM, GROUP, entry_id)
        return

    key = dedup_key(event)
    if not r.set(key, entry_id, nx=True, ex=60 * 60 * 24 * 30):
        audit["result"] = "duplicate"
        r.xadd(AUDIT_STREAM, audit, maxlen=5000, approximate=True)
        r.xack(STREAM, GROUP, entry_id)
        return

    try:
        result = start_sales_case(build_case_args(event, classification))
        data = result.get("data") or {}
        audit["result"] = "case_started"
        audit["case_id"] = str(data.get("case_id", ""))
        audit["process_id"] = str(data.get("process_id", WORKFLOW_ID))
        print(f"SALES {entry_id} -> case {audit['case_id']}", flush=True)
    except (HTTPError, URLError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        r.delete(key)
        audit["result"] = "error"
        audit["error"] = f"{type(exc).__name__}: {str(exc)[:500]}"
        r.xadd(DEAD_STREAM, audit, maxlen=1000, approximate=True)
        r.xack(STREAM, GROUP, entry_id)
        raise

    r.xadd(AUDIT_STREAM, audit, maxlen=5000, approximate=True)
    r.xack(STREAM, GROUP, entry_id)


def main() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    ensure_group(r)
    while not STOP:
        items = r.xreadgroup(GROUP, CONSUMER, {STREAM: ">"}, count=10, block=BLOCK_SECONDS)
        for _stream, messages in items:
            for entry_id, raw in messages:
                try:
                    process_event(r, entry_id, decode_fields(raw))
                except Exception as exc:  # noqa: BLE001 - keep long-running consumer alive.
                    print(f"ERR {entry_id}: {type(exc).__name__}: {str(exc)[:160]}", flush=True)
    r.close()


if __name__ == "__main__":
    main()
