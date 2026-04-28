#!/usr/bin/env python3
"""Pack uncertain Telegram router events into actionable context packets."""
from __future__ import annotations

import json
import os
import signal
import time
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

import redis

REDIS_HOST = os.environ.get("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
STREAM = os.environ.get("TELEGRAM_CONTEXT_STREAM", "telegram:needs_context")
GROUP = os.environ.get("TELEGRAM_CONTEXT_GROUP", "context-packer")
CONSUMER = os.environ.get("TELEGRAM_CONTEXT_CONSUMER", "context-packer-1")
OUT_STREAM = os.environ.get("TELEGRAM_CONTEXT_OUT_STREAM", "telegram:incoming")
AUDIT_STREAM = os.environ.get("TELEGRAM_CONTEXT_AUDIT_STREAM", "telegram:context_audit")
DEAD_STREAM = os.environ.get("TELEGRAM_CONTEXT_DEAD_STREAM", "telegram:needs_context:dead_letter")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("TELEGRAM_CONTEXT_MODEL", os.environ.get("TELEGRAM_ROUTER_MODEL", "google/gemini-2.0-flash-lite-001"))
MIN_CONFIDENCE = float(os.environ.get("TELEGRAM_CONTEXT_MIN_CONFIDENCE", "0.65"))
TIMEOUT_SEC = float(os.environ.get("TELEGRAM_CONTEXT_TIMEOUT_SEC", "8.0"))
MAX_CONTEXT_CHARS = int(os.environ.get("TELEGRAM_CONTEXT_MAX_CHARS", "6000"))

STOP = False


def _stop(_signum, _frame) -> None:
    global STOP
    STOP = True


def _parse_json(raw: str) -> dict:
    raw = (raw or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        raw = raw.replace("json\n", "", 1).replace("JSON\n", "", 1)
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        raw = raw[start : end + 1]
    return json.loads(raw)


def _call_model(event: dict, history: list[dict]) -> dict:
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")

    system = (
        "Ты context packer для Telegram-потока команды. Ответь строго JSON без Markdown. "
        "Определи, нужно ли будить агента, и если да — собери короткий context packet. "
        "should_route=true только если есть практическое действие/вопрос/запрос к ассистенту. "
        "Если это обычный разговор, FYI или реклама — should_route=false. "
        "Формат: {\"should_route\":true|false,\"route\":\"sasuke|ops|lead|task|none\","
        "\"confidence\":0.0,\"summary\":\"...\",\"requested_action\":\"...\",\"reason\":\"...\"}"
    )
    payload = {
        "current_event": {
            "chat_id": event.get("chat_id", ""),
            "chat_title": event.get("chat_title", ""),
            "sender": event.get("sender_name") or event.get("sender_username") or "?",
            "text": (event.get("text") or "")[:1500],
            "router_route": event.get("router_route", "none"),
            "router_reason": event.get("router_reason", ""),
        },
        "recent_history": history,
    }
    body = json.dumps(
        {
            "model": MODEL,
            "temperature": 0,
            "max_tokens": 500,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)[:MAX_CONTEXT_CHARS]},
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urlrequest.Request(
        OPENROUTER_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://agent.eaprelsky.ru",
            "X-Title": "Konoha Telegram Context Packer",
        },
        method="POST",
    )
    opener = urlrequest.build_opener(urlrequest.ProxyHandler({}))
    with opener.open(req, timeout=TIMEOUT_SEC) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    return _parse_json(content)


def _decode_fields(raw: dict) -> dict:
    return {str(k): str(v) for k, v in raw.items()}


def _load_history(event: dict) -> list[dict]:
    raw = event.get("router_context", "")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if isinstance(parsed, list):
        return parsed[-50:]
    return []


def _as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "да"}
    return False


def _build_agent_event(event: dict, packed: dict) -> dict:
    route = str(packed.get("route") or event.get("router_route") or "sasuke").lower()
    if route not in {"sasuke", "ops", "lead", "task", "none"}:
        route = "sasuke"
    summary = str(packed.get("summary") or "").strip()
    requested_action = str(packed.get("requested_action") or "").strip()
    reason = str(packed.get("reason") or "").strip()
    text = (
        "Context packet from Telegram router\n"
        f"Chat: {event.get('chat_title') or event.get('chat_id')}\n"
        f"Sender: {event.get('sender_name') or event.get('sender_username') or '?'}\n"
        f"Current message: {event.get('text', '')}\n\n"
        f"Summary: {summary}\n"
        f"Requested action: {requested_action}\n"
        f"Router reason: {reason}\n\n"
        "Обработай с учетом контекста и при необходимости ответь через tg-send-user.py."
    )
    return {
        "source": "context_packer",
        "chat_id": event.get("chat_id", ""),
        "chat_title": event.get("chat_title", ""),
        "is_group": event.get("is_group", "1"),
        "msg_id": event.get("msg_id", ""),
        "sender_id": event.get("sender_id", ""),
        "sender_name": event.get("sender_name", ""),
        "sender_username": event.get("sender_username", ""),
        "text": text,
        "reply_to": event.get("msg_id", ""),
        "timestamp": event.get("timestamp", ""),
        "action_hint": "respond",
        "router_route": route,
        "router_confidence": f"{float(packed.get('confidence', 0.0)):.2f}",
        "router_reason": reason,
    }


def _ensure_group(r: redis.Redis) -> None:
    try:
        r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def _process_item(r: redis.Redis, entry_id: str, raw: dict) -> None:
    event = _decode_fields(raw)
    try:
        packed = _call_model(event, _load_history(event))
        confidence = float(packed.get("confidence", 0.0))
        should_route = _as_bool(packed.get("should_route")) and confidence >= MIN_CONFIDENCE
        audit = {
            "original_id": entry_id,
            "chat_id": event.get("chat_id", ""),
            "msg_id": event.get("msg_id", ""),
            "should_route": "1" if should_route else "0",
            "confidence": f"{confidence:.2f}",
            "route": str(packed.get("route", "none")),
            "reason": str(packed.get("reason", ""))[:500],
        }
        r.xadd(AUDIT_STREAM, audit, maxlen=5000, approximate=True)
        if should_route:
            routed = _build_agent_event(event, packed)
            out_id = r.xadd(OUT_STREAM, routed, maxlen=1000, approximate=True)
            print(f"ROUTE {entry_id} -> {OUT_STREAM}/{out_id} conf={confidence:.2f}", flush=True)
        else:
            print(f"SKIP {entry_id} conf={confidence:.2f} reason={audit['reason'][:80]}", flush=True)
        r.xack(STREAM, GROUP, entry_id)
    except (HTTPError, URLError, TimeoutError, RuntimeError, json.JSONDecodeError, KeyError, ValueError) as e:
        r.xadd(DEAD_STREAM, {
            "original_id": entry_id,
            "error": f"{type(e).__name__}: {str(e)[:500]}",
            "failed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "chat_id": event.get("chat_id", ""),
            "msg_id": event.get("msg_id", ""),
        }, maxlen=1000, approximate=True)
        r.xack(STREAM, GROUP, entry_id)
        print(f"DEAD {entry_id}: {type(e).__name__}: {e}", flush=True)


def _read_pending(r: redis.Redis) -> list:
    # Drain this consumer's pending messages after a restart/crash before reading new events.
    return r.xreadgroup(GROUP, CONSUMER, {STREAM: "0"}, count=5)


def main() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    _ensure_group(r)
    print(f"Context packer started stream={STREAM} group={GROUP} model={MODEL}", flush=True)

    while not STOP:
        try:
            batches = _read_pending(r)
            if not batches:
                batches = r.xreadgroup(GROUP, CONSUMER, {STREAM: ">"}, count=5, block=5000)
            if not batches:
                continue
            for _stream, items in batches:
                for entry_id, raw in items:
                    _process_item(r, entry_id, raw)
        except redis.RedisError as e:
            print(f"REDIS ERR: {e}", flush=True)
            time.sleep(2)


if __name__ == "__main__":
    main()
