#!/usr/bin/env python3
"""Convert Telegram image requests into text packets for text-only agents."""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import signal
import time
from pathlib import Path
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

import redis

REDIS_HOST = os.environ.get("REDIS_HOST", "127.0.0.1")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
STREAM = os.environ.get("TELEGRAM_VISION_STREAM", "telegram:vision_requests")
GROUP = os.environ.get("TELEGRAM_VISION_GROUP", "vision-packer")
CONSUMER = os.environ.get("TELEGRAM_VISION_CONSUMER", "vision-packer-1")
OUT_STREAM = os.environ.get("TELEGRAM_VISION_OUT_STREAM", "telegram:incoming")
AUDIT_STREAM = os.environ.get("TELEGRAM_VISION_AUDIT_STREAM", "telegram:vision_audit")
DEAD_STREAM = os.environ.get("TELEGRAM_VISION_DEAD_STREAM", "telegram:vision_requests:dead_letter")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = os.environ.get("TELEGRAM_VISION_MODEL", "qwen/qwen3.5-flash")
TIMEOUT_SEC = float(os.environ.get("TELEGRAM_VISION_TIMEOUT_SEC", "20.0"))
MAX_IMAGE_BYTES = int(os.environ.get("TELEGRAM_VISION_MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))

STOP = False
RETRYABLE_OPENROUTER_STATUS = {401, 402, 403, 408, 409, 429, 500, 502, 503, 504}


def _stop(_signum, _frame) -> None:
    global STOP
    STOP = True


def _decode_fields(raw: dict) -> dict:
    return {str(k): str(v) for k, v in raw.items()}


def _image_data_url(path: str) -> str:
    image_path = Path(path)
    if not image_path.exists():
        raise FileNotFoundError(path)
    size = image_path.stat().st_size
    if size > MAX_IMAGE_BYTES:
        raise ValueError(f"image too large: {size} bytes > {MAX_IMAGE_BYTES}")
    mime = mimetypes.guess_type(str(image_path))[0] or "image/jpeg"
    data = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{data}"


def _openrouter_api_keys() -> list[str]:
    keys: list[str] = []
    for name in ["OPENROUTER_API_KEY", "OPENROUTER_API_KEYS"]:
        raw = os.environ.get(name, "")
        keys.extend(part.strip() for part in raw.split(",") if part.strip())
    for idx in range(1, 6):
        raw = os.environ.get(f"OPENROUTER_API_KEY_FALLBACK_{idx}", "")
        if raw.strip():
            keys.append(raw.strip())
    deduped: list[str] = []
    seen: set[str] = set()
    for key in keys:
        if key not in seen:
            seen.add(key)
            deduped.append(key)
    return deduped


def _openrouter_json(body: bytes, title: str, timeout: float) -> dict:
    keys = _openrouter_api_keys()
    if not keys:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    opener = urlrequest.build_opener(urlrequest.ProxyHandler({}))
    last_error: Exception | None = None
    for idx, api_key in enumerate(keys, start=1):
        req = urlrequest.Request(
            OPENROUTER_URL,
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://agent.eaprelsky.ru",
                "X-Title": title,
            },
            method="POST",
        )
        try:
            with opener.open(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            last_error = exc
            if exc.code not in RETRYABLE_OPENROUTER_STATUS or idx == len(keys):
                raise
            print(f"OpenRouter key #{idx} failed with HTTP {exc.code}; trying fallback", flush=True)
        except URLError as exc:
            last_error = exc
            if idx == len(keys):
                raise
            print(f"OpenRouter key #{idx} network error; trying fallback", flush=True)
    raise RuntimeError(f"OpenRouter request failed: {last_error}")


def _call_model(event: dict) -> str:
    image_path = event.get("attachment_path", "")
    if not image_path:
        raise ValueError("attachment_path is required")

    prompt = (
        "Ты vision preprocessor для Telegram-ассистента. "
        "Опиши изображение и извлеки смысл, который нужен текстовому агенту для ответа. "
        "Если на изображении есть текст, таблица, скриншот интерфейса, ошибка или документ — перепиши важное. "
        "Ответь кратко, но достаточно подробно для дальнейшей работы агента."
    )
    user_text = (
        f"Chat: {event.get('chat_title') or event.get('chat_id')}\n"
        f"Sender: {event.get('sender_name') or event.get('sender_username') or '?'}\n"
        f"Message text: {event.get('text', '')}\n"
        f"Attachment kind: {event.get('attachment_kind', '')}\n"
    )
    body = json.dumps(
        {
            "model": MODEL,
            "temperature": 0,
            "max_tokens": 900,
            "messages": [
                {"role": "system", "content": prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": _image_data_url(image_path)}},
                    ],
                },
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    data = _openrouter_json(body, "Konoha Telegram Vision Packer", TIMEOUT_SEC)
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content.strip():
        raise RuntimeError("empty vision model response")
    return content.strip()


def _build_agent_event(event: dict, vision_summary: str) -> dict:
    text = (
        "Vision packet from Telegram router\n"
        f"Chat: {event.get('chat_title') or event.get('chat_id')}\n"
        f"Sender: {event.get('sender_name') or event.get('sender_username') or '?'}\n"
        f"Original message: {event.get('text', '')}\n"
        f"Attachment: {event.get('attachment_kind', '')} — {event.get('attachment_path', '')}\n\n"
        f"Vision summary:\n{vision_summary}\n\n"
        "Обработай это как сообщение пользователя и при необходимости ответь через tg-send-user.py."
    )
    return {
        "source": "vision_packer",
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
        "router_route": event.get("router_route", "sasuke"),
        "router_confidence": event.get("router_confidence", "1.00"),
        "router_reason": event.get("router_reason", "") or "vision_preprocessed",
        "attachment_path": event.get("attachment_path", ""),
        "attachment_kind": event.get("attachment_kind", ""),
        "required_capabilities": "text",
        "target_agent": event.get("target_agent", "sasuke"),
        "target_stream": OUT_STREAM,
        "capability_reason": "vision_preprocessed",
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
        summary = _call_model(event)
        routed = _build_agent_event(event, summary)
        out_id = r.xadd(OUT_STREAM, routed, maxlen=1000, approximate=True)
        r.xadd(
            AUDIT_STREAM,
            {
                "original_id": entry_id,
                "chat_id": event.get("chat_id", ""),
                "msg_id": event.get("msg_id", ""),
                "model": MODEL,
                "out_stream": OUT_STREAM,
                "out_id": str(out_id),
                "summary_chars": str(len(summary)),
            },
            maxlen=5000,
            approximate=True,
        )
        r.xack(STREAM, GROUP, entry_id)
        print(f"VISION {entry_id} -> {OUT_STREAM}/{out_id} chars={len(summary)}", flush=True)
    except (HTTPError, URLError, TimeoutError, RuntimeError, json.JSONDecodeError, KeyError, ValueError, OSError) as e:
        r.xadd(
            DEAD_STREAM,
            {
                "original_id": entry_id,
                "error": f"{type(e).__name__}: {str(e)[:500]}",
                "failed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "chat_id": event.get("chat_id", ""),
                "msg_id": event.get("msg_id", ""),
                "attachment_path": event.get("attachment_path", ""),
            },
            maxlen=1000,
            approximate=True,
        )
        r.xack(STREAM, GROUP, entry_id)
        print(f"VISION DEAD {entry_id}: {type(e).__name__}: {e}", flush=True)


def _read_pending(r: redis.Redis) -> list:
    return r.xreadgroup(GROUP, CONSUMER, {STREAM: "0"}, count=2)


def main() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    _ensure_group(r)
    print(f"Vision packer started stream={STREAM} group={GROUP} model={MODEL}", flush=True)

    while not STOP:
        try:
            batches = _read_pending(r)
            if not batches:
                batches = r.xreadgroup(GROUP, CONSUMER, {STREAM: ">"}, count=2, block=5000)
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
