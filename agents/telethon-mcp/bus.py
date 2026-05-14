"""Bus v5: async Redis to not block Telethon event loop. Includes action_hint routing (#484)."""
from telethon import TelegramClient, events
import asyncio
import redis.asyncio as aioredis
import redis as sync_redis
import hashlib
import re
import os
import json
import sys
from datetime import datetime
from urllib import request as urlrequest
from urllib.error import URLError, HTTPError

sys.path.insert(0, '/home/ubuntu/konoha/scripts')
from model_capabilities import apply_capability_fields  # noqa: E402

SESSION = '/opt/shared/telegram_session'
WIKI_DIR = '/opt/shared/wiki/group-chats'
os.makedirs(WIKI_DIR, exist_ok=True)

# Sync redis for stream group creation only. The bus owns only command/outgoing
# consumer groups; incoming stream groups are owned by agent watchdogs or MCP.
sr = sync_redis.Redis(host='localhost', port=6379, decode_responses=True)
for s in ['telegram:outgoing', 'telegram:commands']:
    try:
        sr.xgroup_create(s, 'claude-agents', id='0', mkstream=True)
    except:
        pass
sr.close()

# ── Trusted users & routing config (#484) ─────────────────────────────────
TRUSTED_USERS_FILE = '/opt/shared/.trusted-users.json'
MY_USER_ID = None  # filled after login

# Words that indicate a message is addressed to the user account (not the bot)
USER_ACCOUNT_TRIGGERS = ['клод', 'claude', '@eaclaude']
# Words that indicate a message is for the bot — defer to bot path
BOT_TRIGGERS = ['@eaprelsky_agent_bot']

ROUTER_ENABLED = os.environ.get('TELEGRAM_ROUTER_ENABLED', '0') == '1'
ROUTER_MODEL = os.environ.get('TELEGRAM_ROUTER_MODEL', 'google/gemini-2.0-flash-lite-001')
ROUTER_MIN_CONFIDENCE = float(os.environ.get('TELEGRAM_ROUTER_MIN_CONFIDENCE', '0.75'))
ROUTER_TIMEOUT_SEC = float(os.environ.get('TELEGRAM_ROUTER_TIMEOUT_SEC', '4.0'))
ROUTER_HISTORY_LIMIT = int(os.environ.get('TELEGRAM_ROUTER_HISTORY_LIMIT', '20'))
OPENROUTER_API_KEY = os.environ.get('OPENROUTER_API_KEY', '')
OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
RETRYABLE_OPENROUTER_STATUS = {401, 402, 403, 408, 409, 429, 500, 502, 503, 504}

OUTGOING_STREAM = 'telegram:outgoing'
OUTGOING_GROUP = 'claude-agents'
OUTGOING_CONSUMER = 'sender'
OUTGOING_DEAD_LETTER_STREAM = 'telegram:outgoing:dead_letter'
OUTGOING_STALE_PENDING_MAX_AGE_SEC = int(os.environ.get('TELEGRAM_OUTGOING_STALE_PENDING_MAX_AGE_SEC', '3600'))
OUTGOING_MAX_RUNTIME_ATTEMPTS = int(os.environ.get('TELEGRAM_OUTGOING_MAX_RUNTIME_ATTEMPTS', '3'))

def _load_trusted_ids() -> set[int]:
    """Load trusted user IDs from shared config."""
    cfg = json.loads(open(TRUSTED_USERS_FILE).read())
    ids = set()
    if cfg.get('owner', {}).get('telegram_id'):
        ids.add(int(cfg['owner']['telegram_id']))
    for u in cfg.get('trusted', []):
        if u.get('telegram_id'):
            ids.add(int(u['telegram_id']))
    return ids

TRUSTED_IDS_CACHE: set[int] = set()
TRUSTED_IDS_MTIME_NS: int | None = None


def _current_trusted_ids() -> set[int]:
    """Return trusted IDs, reloading the shared file when it changes."""
    global TRUSTED_IDS_CACHE, TRUSTED_IDS_MTIME_NS
    try:
        mtime_ns = os.stat(TRUSTED_USERS_FILE).st_mtime_ns
    except Exception as e:
        print(f'TRUSTED USERS STAT ERR: {e}', flush=True)
        return TRUSTED_IDS_CACHE

    if TRUSTED_IDS_MTIME_NS == mtime_ns:
        return TRUSTED_IDS_CACHE

    try:
        trusted_ids = _load_trusted_ids()
    except Exception as e:
        print(f'TRUSTED USERS RELOAD ERR: {e}', flush=True)
        return TRUSTED_IDS_CACHE

    TRUSTED_IDS_CACHE = trusted_ids
    TRUSTED_IDS_MTIME_NS = mtime_ns
    print(f'TRUSTED USERS RELOADED: {len(trusted_ids)} ids', flush=True)
    return TRUSTED_IDS_CACHE


_current_trusted_ids()


def _openrouter_api_keys() -> list[str]:
    keys: list[str] = []
    for name in ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS']:
        raw = os.environ.get(name, '')
        keys.extend(part.strip() for part in raw.split(',') if part.strip())
    for idx in range(1, 6):
        raw = os.environ.get(f'OPENROUTER_API_KEY_FALLBACK_{idx}', '')
        if raw.strip():
            keys.append(raw.strip())
    deduped: list[str] = []
    seen: set[str] = set()
    for key in keys:
        if key not in seen:
            seen.add(key)
            deduped.append(key)
    return deduped


def _history_key(chat_id: str | int) -> str:
    return f'telegram:history:{chat_id}'


async def _load_recent_history(rd: aioredis.Redis, chat_id: str | int) -> list[dict]:
    """Load compact recent chat history for router context."""
    try:
        rows = await rd.lrange(_history_key(chat_id), -ROUTER_HISTORY_LIMIT, -1)
    except Exception as e:
        print(f'HISTORY READ ERR [{chat_id}]: {e}', flush=True)
        return []
    history: list[dict] = []
    for row in rows:
        try:
            history.append(json.loads(row))
        except Exception:
            continue
    return history


async def _append_history(rd: aioredis.Redis, chat_id: str | int, item: dict) -> None:
    """Persist compact chat history; values are safe for router context only."""
    key = _history_key(chat_id)
    compact = {
        'ts': item.get('timestamp', ''),
        'sender': item.get('sender_name') or item.get('sender_username') or '?',
        'text': (item.get('text') or '')[:800],
        'action_hint': item.get('action_hint', ''),
        'route': item.get('router_route', ''),
        'attachment_kind': item.get('attachment_kind', ''),
        'required_capabilities': item.get('required_capabilities', ''),
        'missing_capabilities': item.get('missing_capabilities', ''),
    }
    try:
        await rd.rpush(key, json.dumps(compact, ensure_ascii=False))
        await rd.ltrim(key, -100, -1)
        await rd.expire(key, 7 * 24 * 3600)
    except Exception as e:
        print(f'HISTORY WRITE ERR [{chat_id}]: {e}', flush=True)


def _stream_batch_has_messages(results: list) -> bool:
    """Return True only when XREADGROUP returned at least one message."""
    return any(messages for _stream_name, messages in results)


def _is_stale_stream_id(redis_id: str, *, max_age_sec: int) -> bool:
    """Return True for old pending Redis stream IDs that should not be replayed."""
    try:
        created_ms = int(str(redis_id).split('-', 1)[0])
    except (TypeError, ValueError):
        return False
    current_ms = int(datetime.now().timestamp() * 1000)
    return (current_ms - created_ms) > max_age_sec * 1000


async def _dead_letter_outgoing(
    rd: aioredis.Redis,
    msg_id: str,
    data: dict,
    *,
    reason: str,
    error: str,
) -> None:
    """Move an outgoing message to DLQ and ack it from the live stream."""
    fields = {str(k): str(v) for k, v in data.items() if v is not None}
    fields.update({
        'source_stream': OUTGOING_STREAM,
        'source_id': msg_id,
        'dead_letter_reason': reason,
        'last_error': str(error)[:500],
        'failed_at': datetime.now().isoformat(),
    })
    await rd.xadd(OUTGOING_DEAD_LETTER_STREAM, fields, maxlen=1000, approximate=True)
    await rd.xack(OUTGOING_STREAM, OUTGOING_GROUP, msg_id)
    print(f'OUT DLQ [{msg_id}] {reason}: {str(error)[:160]}', flush=True)



def _parse_router_json(raw: str) -> dict:
    """Parse a tiny JSON object from an LLM response."""
    raw = (raw or '').strip()
    if raw.startswith('```'):
        raw = raw.strip('`')
        raw = raw.replace('json\n', '', 1).replace('JSON\n', '', 1)
    start = raw.find('{')
    end = raw.rfind('}')
    if start >= 0 and end > start:
        raw = raw[start:end + 1]
    return json.loads(raw)


def _call_openrouter_router(payload: dict) -> dict:
    """Blocking OpenRouter call; run via asyncio.to_thread from the event loop."""
    keys = _openrouter_api_keys()
    if not keys:
        raise RuntimeError('OPENROUTER_API_KEY is not set')

    system = (
        'Ты входной классификатор Telegram для команды. Ответь строго JSON без Markdown. '
        'Действия: respond = агент должен обработать и, возможно, ответить; '
        'needs_context = потенциально важное, но нужен контекст предыдущих сообщений; '
        'observe = сохранить в лог, но не будить LLM-агента; drop = шум/спам. '
        'Будь консервативен: respond только если есть явная задача, вопрос к AI/агенту, просьба проверить/создать/найти/оценить/зарегистрировать, '
        'или сообщение явно требует реакции операционного ассистента. Если смысл зависит от длинного обсуждения, местоимений это/там/выше, '
        'ссылок на прошлые договоренности, вложений или нескольких предыдущих сообщений — выбирай needs_context. '
        'Обычные разговоры, FYI, реклама, обсуждения между людьми -> observe/drop. '
        'route: sasuke для Telegram/user-account помощника, ops для операционных задач, lead для лидов/CRM, task для задач, none если не маршрутизировать. '
        'Формат: {"action":"drop|observe|needs_context|respond","route":"sasuke|ops|lead|task|none","confidence":0.0,"reason":"short"}'
    )
    user = json.dumps(payload, ensure_ascii=False)
    body = json.dumps({
        'model': ROUTER_MODEL,
        'temperature': 0,
        'max_tokens': 120,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
    }).encode('utf-8')
    # Ignore process proxy env: the shared LLM proxy breaks several HTTPS APIs on this host.
    opener = urlrequest.build_opener(urlrequest.ProxyHandler({}))
    last_error: Exception | None = None
    for idx, api_key in enumerate(keys, start=1):
        req = urlrequest.Request(
            OPENROUTER_URL,
            data=body,
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://agent.eaprelsky.ru',
                'X-Title': 'Konoha Telegram Router',
            },
            method='POST',
        )
        try:
            with opener.open(req, timeout=ROUTER_TIMEOUT_SEC) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                break
        except HTTPError as exc:
            last_error = exc
            if exc.code not in RETRYABLE_OPENROUTER_STATUS or idx == len(keys):
                raise
            print(f'OpenRouter key #{idx} failed with HTTP {exc.code}; trying fallback', flush=True)
        except URLError as exc:
            last_error = exc
            if idx == len(keys):
                raise
            print(f'OpenRouter key #{idx} network error; trying fallback', flush=True)
    else:
        raise RuntimeError(f'OpenRouter request failed: {last_error}')
    content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    return _parse_router_json(content)


async def _route_with_llm(
    *,
    text: str,
    chat_title: str,
    sender_name: str,
    sender_username: str,
    is_group: bool,
    rule_action: str,
    recent_history: list[dict] | None = None,
    attachment_kind: str = '',
    attachment_path: str = '',
) -> dict:
    """Classify non-obvious group traffic with a cheap model."""
    if not ROUTER_ENABLED or not _openrouter_api_keys():
        return {'action': rule_action, 'route': 'none', 'confidence': 0.0, 'reason': 'router_disabled'}
    if not is_group or rule_action != 'observe' or (not text.strip() and not attachment_kind):
        return {'action': rule_action, 'route': 'none', 'confidence': 0.0, 'reason': 'router_not_applicable'}

    payload = {
        'chat_title': chat_title,
        'sender_name': sender_name,
        'sender_username': sender_username,
        'text': text[:1200],
        'attachment_kind': attachment_kind,
        'has_attachment': bool(attachment_path),
        'rule_action': rule_action,
        'recent_history': recent_history or [],
    }
    try:
        result = await asyncio.to_thread(_call_openrouter_router, payload)
    except (TimeoutError, URLError, HTTPError, RuntimeError, json.JSONDecodeError, KeyError, IndexError) as e:
        print(f'ROUTER ERR: {type(e).__name__}: {str(e)[:120]}', flush=True)
        return {'action': rule_action, 'route': 'none', 'confidence': 0.0, 'reason': 'router_error'}

    action = str(result.get('action', rule_action)).lower()
    route = str(result.get('route', 'none')).lower()
    try:
        confidence = float(result.get('confidence', 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    reason = str(result.get('reason', ''))[:160]

    if action not in {'drop', 'observe', 'needs_context', 'respond'}:
        action = rule_action
    if route not in {'sasuke', 'ops', 'lead', 'task', 'none'}:
        route = 'none'
    if action == 'respond' and confidence < ROUTER_MIN_CONFIDENCE:
        action = 'needs_context' if confidence >= 0.55 else 'observe'
        reason = f'low_confidence:{reason}'
    if action == 'needs_context' and confidence < 0.45:
        action = 'observe'
        reason = f'low_context_confidence:{reason}'
    if attachment_kind and action == 'observe' and confidence >= 0.55:
        action = 'needs_context'
        reason = f'attachment_context:{reason}'
    return {'action': action, 'route': route, 'confidence': confidence, 'reason': reason}

def _classify_action_hint(
    text: str,
    is_group: bool,
    sender_id: int,
    reply_to_msg_id: str,
    my_sent_msg_ids: dict,
) -> str:
    """Determine action_hint for a message (mirrors channel-server.ts logic).

    Routing rules (#484):
      - Private from trusted → respond
      - Private from unknown → ignore
      - Group mentioning user account → respond
      - Group replying to user's message → respond
      - Group mentioning bot name → observe (let bot/Naruto handle)
      - Other group messages → observe
    """
    text_lower = text.lower()

    # Bot-specific triggers → defer to bot path (Naruto)
    if any(t in text_lower for t in BOT_TRIGGERS):
        return 'observe'

    if not is_group:
        # Private message
        return 'respond' if sender_id in _current_trusted_ids() else 'ignore'

    # Group message
    addressed_to_me = any(t in text_lower for t in USER_ACCOUNT_TRIGGERS)
    is_reply_to_me = (
        reply_to_msg_id
        and str(reply_to_msg_id) in my_sent_msg_ids.get('ids', set())
    )

    if addressed_to_me or is_reply_to_me:
        return 'respond'
    return 'observe'

api_id = int(os.environ.get("TG_API_ID", "2040"))
api_hash = os.environ.get("TG_API_HASH", "")
client = TelegramClient(SESSION, api_id, api_hash)

# Track recent sent message IDs per chat for reply detection
_last_sent_per_chat: dict[int, dict] = {}  # chat_id → {msgId, time, ids: set}


@client.on(events.NewMessage)
async def on_message(event):
    if event.out:
        return
    sender = await event.get_sender()
    chat = await event.get_chat()

    sender_name = getattr(sender, 'first_name', '') or 'Unknown'
    sender_last = getattr(sender, 'last_name', '') or ''
    chat_title = getattr(chat, 'title', None) or f'{sender_name} {sender_last}'.strip()
    is_group = hasattr(chat, 'title') and chat.title is not None
    msg_text = event.text or ''

    # Download attachments
    attachment_path = ''
    attachment_kind = ''
    attachment_name = ''
    if event.media:
        try:
            from telethon.tl.types import (MessageMediaPhoto, MessageMediaDocument,
                                           DocumentAttributeFilename, DocumentAttributeAudio)
            att_dir = '/opt/shared/attachments'
            os.makedirs(att_dir, exist_ok=True)
            if isinstance(event.media, MessageMediaPhoto):
                attachment_kind = 'photo'
                fname = f'{int(datetime.now().timestamp()*1000)}-photo-{event.id}.jpg'
                attachment_path = os.path.join(att_dir, fname)
                await event.download_media(attachment_path)
            elif isinstance(event.media, MessageMediaDocument) and event.media.document:
                doc = event.media.document
                # Determine kind and filename from attributes
                for attr in doc.attributes:
                    if isinstance(attr, DocumentAttributeFilename):
                        attachment_name = attr.file_name
                    if isinstance(attr, DocumentAttributeAudio):
                        attachment_kind = 'voice' if attr.voice else 'audio'
                if not attachment_kind:
                    attachment_kind = 'document'
                safe_name = (attachment_name or f'{attachment_kind}-{event.id}').replace('/', '_')
                fname = f'{int(datetime.now().timestamp()*1000)}-{safe_name}'
                attachment_path = os.path.join(att_dir, fname)
                await event.download_media(attachment_path)
            if attachment_path:
                print(f'ATTACH [{event.chat_id}]: {attachment_kind} → {attachment_path}', flush=True)
        except Exception as e:
            print(f'ATTACH ERR: {e}', flush=True)

    sender_id = getattr(sender, 'id', 0)
    reply_to_msg_id = str(event.reply_to.reply_to_msg_id) if event.reply_to else ''
    reply_to_text = ''
    if event.reply_to:
        try:
            reply_msg = await event.get_reply_message()
            if reply_msg and reply_msg.text:
                reply_to_text = reply_msg.text
        except Exception:
            pass

    data = {
        'chat_id': str(event.chat_id),
        'chat_title': chat_title,
        'is_group': '1' if is_group else '0',
        'msg_id': str(event.id),
        'sender_id': str(sender_id),
        'sender_name': f'{sender_name} {sender_last}'.strip(),
        'sender_username': getattr(sender, 'username', '') or '',
        'text': msg_text,
        'reply_to': reply_to_msg_id,
        'reply_to_text': reply_to_text,
        'timestamp': event.date.isoformat(),
    }
    if attachment_path:
        data['attachment_path'] = attachment_path
        data['attachment_kind'] = attachment_kind
    if attachment_name:
        data['attachment_name'] = attachment_name

    rd = aioredis.Redis(host='localhost', port=6379, decode_responses=True)
    recent_history = await _load_recent_history(rd, event.chat_id)

    # Classify action_hint (#484) — prevents dual responses from Naruto + Sasuke.
    rule_action_hint = _classify_action_hint(
        text=msg_text,
        is_group=is_group,
        sender_id=sender_id,
        reply_to_msg_id=reply_to_msg_id,
        my_sent_msg_ids=_last_sent_per_chat.get(event.chat_id, {'ids': set()}),
    )
    router_result = await _route_with_llm(
        text=msg_text,
        chat_title=chat_title,
        sender_name=f'{sender_name} {sender_last}'.strip(),
        sender_username=getattr(sender, 'username', '') or '',
        is_group=is_group,
        rule_action=rule_action_hint,
        recent_history=recent_history,
        attachment_kind=attachment_kind,
        attachment_path=attachment_path,
    )
    action_hint = router_result['action']
    data['action_hint'] = action_hint
    data['router_route'] = router_result.get('route', 'none')
    data['router_confidence'] = f"{router_result.get('confidence', 0.0):.2f}"
    data['router_reason'] = router_result.get('reason', '')
    capability = apply_capability_fields(data, data['router_route'])

    # Dedup: set a routing key so other paths can check if Telethon already handled
    # Key: telegram:routed:{chat_id}:{sender_id}:{first-500-chars-hash}, TTL 120s
    dedup_key = f"telegram:routed:{event.chat_id}:{sender_id}"
    if msg_text:
        dedup_key += f":{hashlib.md5(msg_text[:500].encode()).hexdigest()[:12]}"

    # Check if bot path already claimed this message
    already_routed = await rd.get(dedup_key)
    if already_routed == 'bot':
        print(f'DEDUP [{event.chat_id}] skipping — bot path already routed: {msg_text[:40]}', flush=True)
        await rd.aclose()
        return

    if action_hint == 'respond':
        # Claim and route only actionable messages to Sasuke. Non-actionable
        # group traffic is kept in the audit log, but not sent to the LLM.
        await rd.set(dedup_key, 'telethon', ex=120)
        target_stream = capability.get('target_stream') or 'telegram:incoming'
        await rd.xadd(target_stream, data, maxlen=1000)
        if target_stream != 'telegram:incoming':
            print(
                f"CAPROUTE [{event.chat_id}] {target_stream} "
                f"missing={data.get('missing_capabilities')}: {msg_text[:60]}",
                flush=True,
            )
    elif action_hint == 'needs_context':
        data['router_context'] = json.dumps(recent_history, ensure_ascii=False)
        target_stream = capability.get('target_stream') or 'telegram:needs_context'
        if target_stream == 'telegram:incoming':
            target_stream = 'telegram:needs_context'
        await rd.xadd(target_stream, data, maxlen=1000)
        print(
            f"CONTEXT [{event.chat_id}] {target_stream} {data.get('router_route')} "
            f"conf={data.get('router_confidence')} missing={data.get('missing_capabilities')}: {msg_text[:60]}",
            flush=True,
        )
    else:
        print(
            f"FILTER [{event.chat_id}] {action_hint}/{data.get('router_route')} "
            f"conf={data.get('router_confidence')}: {msg_text[:60]}",
            flush=True,
        )

    await rd.xadd('telegram:log', data, maxlen=5000)
    await _append_history(rd, event.chat_id, data)
    await rd.aclose()

    if is_group and msg_text:
        safe = re.sub(r'[/\s]+', '_', chat_title)[:50]
        date = datetime.now().strftime('%Y-%m-%d')
        with open(os.path.join(WIKI_DIR, f'{safe}_{date}.md'), 'a') as f:
            f.write(f'**[{event.date.strftime("%H:%M")}] {sender_name} {sender_last}:** {msg_text}\n\n')

    print(
        f"IN [{event.chat_id}] {sender_name} [{action_hint}/{data.get('router_route')} "
        f"conf={data.get('router_confidence')}]: {msg_text[:60]}",
        flush=True,
    )

async def outgoing_loop():
    rd = aioredis.Redis(host='localhost', port=6379, decode_responses=True)
    failed_attempts: dict[str, int] = {}
    replay_pending = True
    while True:
        try:
            try:
                await rd.xgroup_create(OUTGOING_STREAM, OUTGOING_GROUP, id='0', mkstream=True)
            except Exception as e:
                if 'BUSYGROUP' not in str(e):
                    raise

            stream_id = '0' if replay_pending else '>'
            msgs = await rd.xreadgroup(
                OUTGOING_GROUP,
                OUTGOING_CONSUMER,
                {OUTGOING_STREAM: stream_id},
                count=1,
                block=100 if replay_pending else 2000,
            )
            if not _stream_batch_has_messages(msgs):
                if replay_pending:
                    replay_pending = False
                    print(f'OUT pending replay drained for {OUTGOING_STREAM}', flush=True)
                continue

            for stream, items in msgs:
                for msg_id, data in items:
                    if replay_pending:
                        if _is_stale_stream_id(msg_id, max_age_sec=OUTGOING_STALE_PENDING_MAX_AGE_SEC):
                            await _dead_letter_outgoing(
                                rd,
                                msg_id,
                                data,
                                reason='stale_pending',
                                error=f'pending older than {OUTGOING_STALE_PENDING_MAX_AGE_SEC}s',
                            )
                            continue

                    chat_id = int(data['chat_id'])
                    text = data.get('text', '')
                    reply_to = int(data['reply_to']) if data.get('reply_to') else None
                    file_path = data.get('file_path')
                    try:
                        if file_path:
                            sent = await client.send_file(chat_id, file_path, caption=text or None, reply_to=reply_to)
                            print(f'OUT FILE [{chat_id}]: {file_path}', flush=True)
                        else:
                            sent = await client.send_message(chat_id, text, reply_to=reply_to, link_preview=False, parse_mode=None)
                            print(f'OUT [{chat_id}]: {text[:40]}', flush=True)
                        # Save sent msg_id for delete_last support
                        sent_key = f'telegram:sent:{chat_id}'
                        await rd.hset(sent_key, msg_id, str(sent.id))
                        await rd.hset(sent_key, 'last', str(sent.id))
                        await rd.expire(sent_key, 7 * 24 * 3600)
                        # Track sent IDs for reply detection in action_hint (#484)
                        entry = _last_sent_per_chat.get(chat_id, {'ids': set(), 'time': 0})
                        entry['ids'].add(str(sent.id))
                        entry['time'] = int(datetime.now().timestamp())
                        # Keep only last 50 IDs per chat to avoid memory bloat
                        if len(entry['ids']) > 50:
                            entry['ids'] = set(list(entry['ids'])[-50:])
                        _last_sent_per_chat[chat_id] = entry
                        await rd.xack(OUTGOING_STREAM, OUTGOING_GROUP, msg_id)
                        failed_attempts.pop(msg_id, None)
                    except Exception as e:
                        failed_attempts[msg_id] = failed_attempts.get(msg_id, 0) + 1
                        if failed_attempts[msg_id] >= OUTGOING_MAX_RUNTIME_ATTEMPTS:
                            await _dead_letter_outgoing(
                                rd,
                                msg_id,
                                data,
                                reason='send_failed',
                                error=str(e),
                            )
                            failed_attempts.pop(msg_id, None)
                        else:
                            print(
                                f'SEND ERR [{msg_id}] attempt={failed_attempts[msg_id]}/'
                                f'{OUTGOING_MAX_RUNTIME_ATTEMPTS}: {e}',
                                flush=True,
                            )
        except Exception as e:
            if 'Connection' not in str(e):
                print(f'OUT ERR: {e}', flush=True)
            await asyncio.sleep(1)

async def commands_loop():
    rd = aioredis.Redis(host='localhost', port=6379, decode_responses=True)
    while True:
        try:
            msgs = await rd.xreadgroup('claude-agents', 'commander', {'telegram:commands': '>'}, count=1, block=2000)
            for stream, items in msgs:
                for msg_id, data in items:
                    cmd = data.get('command', '')
                    request_id = data.get('request_id', '')
                    try:
                        if cmd == 'history':
                            chat_id = int(data['chat_id'])
                            limit = int(data.get('limit', 30))
                            messages = await client.get_messages(chat_id, limit=limit)
                            lines = []
                            for m in reversed(messages):
                                if m is None:
                                    continue
                                sender = await m.get_sender()
                                name = getattr(sender, 'first_name', '') or 'Unknown'
                                last = getattr(sender, 'last_name', '') or ''
                                ts = m.date.strftime('%H:%M') if m.date else ''
                                text = m.text or '[media]'
                                out_mark = ' (you)' if m.out else ''
                                lines.append(f'[{ts}] {name} {last}{out_mark}: {text}')
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': '\n'.join(lines)}), ex=60)

                        elif cmd == 'edit':
                            chat_id = int(data['chat_id'])
                            edit_msg_id = int(data['msg_id'])
                            text = data['text']
                            await client.edit_message(chat_id, edit_msg_id, text)
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': 'ok'}), ex=60)

                        elif cmd == 'delete':
                            chat_id = int(data['chat_id'])
                            msg_id = int(data['msg_id'])
                            await client.delete_messages(chat_id, [msg_id])
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': 'ok'}), ex=60)

                        elif cmd == 'delete_last':
                            chat_id = int(data['chat_id'])
                            last_id = await rd.hget(f'telegram:sent:{chat_id}', 'last')
                            import json
                            if last_id:
                                await client.delete_messages(chat_id, [int(last_id)])
                                await rd.set(f'telegram:result:{request_id}', json.dumps({'data': f'deleted {last_id}'}), ex=60)
                            else:
                                await rd.set(f'telegram:result:{request_id}', json.dumps({'data': 'error: no last message found for this chat'}), ex=60)

                        elif cmd == 'delete_msg':
                            chat_id = int(data['chat_id'])
                            del_msg_id = int(data['msg_id'])
                            await client.delete_messages(chat_id, [del_msg_id])
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': 'ok'}), ex=60)

                        elif cmd == 'mark_read':
                            from telethon import functions as tl_functions
                            chat_id = int(data['chat_id'])
                            read_msg_id = int(data['msg_id'])
                            peer = await client.get_input_entity(chat_id)
                            await client(tl_functions.messages.ReadHistoryRequest(
                                peer=peer,
                                max_id=read_msg_id,
                            ))
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': 'ok'}), ex=60)

                        elif cmd == 'react':
                            from telethon.tl.functions.messages import SendReactionRequest
                            from telethon.tl.types import ReactionEmoji
                            chat_id = int(data['chat_id'])
                            react_msg_id = int(data['msg_id'])
                            emoji = data.get('emoji', '👍')
                            peer = await client.get_input_entity(chat_id)
                            await client(SendReactionRequest(
                                peer=peer,
                                msg_id=react_msg_id,
                                reaction=[ReactionEmoji(emoticon=emoji)]
                            ))
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': 'ok'}), ex=60)

                        elif cmd == 'get_contacts':
                            from telethon.tl.functions.contacts import GetContactsRequest
                            result = await client(GetContactsRequest(hash=0))
                            contacts_info = []
                            for user in result.users:
                                uid = user.id
                                fname = getattr(user, 'first_name', '') or ''
                                lname = getattr(user, 'last_name', '') or ''
                                uname = getattr(user, 'username', '') or ''
                                phone = getattr(user, 'phone', '') or ''
                                mutual = getattr(user, 'mutual_contact', False)
                                contacts_info.append(f'{fname} {lname} (@{uname}) id:{uid} phone:{phone} mutual:{mutual}')
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': '\n'.join(contacts_info) or 'no contacts'}), ex=120)

                        elif cmd == 'join_channel':
                            from telethon.tl.functions.channels import JoinChannelRequest
                            channel = data['channel']
                            entity = await client.get_entity(channel)
                            await client(JoinChannelRequest(entity))
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': f'joined {channel}'}), ex=60)

                        elif cmd == 'list_dialogs':
                            limit = int(data.get('limit', 50))
                            dialogs = await client.get_dialogs(limit=limit)
                            lines = []
                            for d in dialogs:
                                name = getattr(d.entity, 'title', None) or getattr(d.entity, 'first_name', '') or 'Unknown'
                                eid = d.entity.id
                                etype = type(d.entity).__name__
                                lines.append(f'{eid} [{etype}] {name}')
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': '\n'.join(lines)}), ex=60)

                        elif cmd == 'get_entity':
                            entity_id = data['entity']
                            try:
                                entity_id = int(entity_id)
                            except (ValueError, TypeError):
                                pass
                            entity = await client.get_entity(entity_id)
                            import json
                            name = getattr(entity, 'title', None) or getattr(entity, 'first_name', '') or 'Unknown'
                            eid = entity.id
                            etype = type(entity).__name__
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': f'{eid} [{etype}] {name}'}), ex=60)

                        else:
                            import json
                            await rd.set(f'telegram:result:{request_id}', json.dumps({'data': f'unknown command: {cmd}'}), ex=60)

                    except Exception as e:
                        import json
                        await rd.set(f'telegram:result:{request_id}', json.dumps({'data': f'error: {e}'}), ex=60)
                        print(f'CMD ERR [{cmd}]: {e}', flush=True)

                    await rd.xack('telegram:commands', 'claude-agents', msg_id)
                    print(f'CMD [{cmd}] request_id={request_id}', flush=True)
        except Exception as e:
            if 'Connection' not in str(e):
                print(f'CMD LOOP ERR: {e}', flush=True)
            await asyncio.sleep(1)

async def main():
    global MY_USER_ID
    await client.connect()
    me = await client.get_me()
    MY_USER_ID = me.id
    print(f'Bus v5 (async redis, action_hint routing): {me.first_name} (ID: {me.id})', flush=True)

    out_task = asyncio.create_task(outgoing_loop())
    cmd_task = asyncio.create_task(commands_loop())

    async def task_watchdog():
        nonlocal out_task, cmd_task
        while True:
            await asyncio.sleep(5)
            if out_task.done():
                print('WATCHDOG: outgoing_loop died, restarting', flush=True)
                out_task = asyncio.create_task(outgoing_loop())
            if cmd_task.done():
                print('WATCHDOG: commands_loop died, restarting', flush=True)
                cmd_task = asyncio.create_task(commands_loop())

    asyncio.create_task(task_watchdog())
    await client.run_until_disconnected()

asyncio.run(main())
