"""Bus v5: async Redis to not block Telethon event loop. Includes action_hint routing (#484)."""
from telethon import TelegramClient, events
import asyncio
import redis.asyncio as aioredis
import redis as sync_redis
import hashlib
import re
import os
import json
from datetime import datetime

SESSION = '/opt/shared/telegram_session'
WIKI_DIR = '/opt/shared/wiki/group-chats'
os.makedirs(WIKI_DIR, exist_ok=True)

# Sync redis for stream group creation only
sr = sync_redis.Redis(host='localhost', port=6379, decode_responses=True)
for s in ['telegram:incoming', 'telegram:outgoing', 'telegram:log', 'telegram:commands']:
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

def _load_trusted_ids() -> set[int]:
    """Load trusted user IDs from shared config."""
    try:
        cfg = json.loads(open(TRUSTED_USERS_FILE).read())
        ids = set()
        if cfg.get('owner', {}).get('telegram_id'):
            ids.add(int(cfg['owner']['telegram_id']))
        for u in cfg.get('trusted', []):
            if u.get('telegram_id'):
                ids.add(int(u['telegram_id']))
        return ids
    except Exception:
        return set()

TRUSTED_IDS = _load_trusted_ids()

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
        return 'respond' if sender_id in TRUSTED_IDS else 'ignore'

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
        'timestamp': event.date.isoformat(),
    }
    if attachment_path:
        data['attachment_path'] = attachment_path
        data['attachment_kind'] = attachment_kind
    if attachment_name:
        data['attachment_name'] = attachment_name

    # Classify action_hint (#484) — prevents dual responses from Naruto + Sasuke
    action_hint = _classify_action_hint(
        text=msg_text,
        is_group=is_group,
        sender_id=sender_id,
        reply_to_msg_id=reply_to_msg_id,
        my_sent_msg_ids=_last_sent_per_chat.get(event.chat_id, {'ids': set()}),
    )
    data['action_hint'] = action_hint

    # Dedup: set a routing key so other paths can check if Telethon already handled
    # Key: telegram:routed:{chat_id}:{sender_id}:{first-50-chars-hash}, TTL 30s
    rd = aioredis.Redis(host='localhost', port=6379, decode_responses=True)
    dedup_key = f"telegram:routed:{event.chat_id}:{sender_id}"
    if msg_text:
        dedup_key += f":{hashlib.md5(msg_text[:100].encode()).hexdigest()[:12]}"

    # Check if bot path already claimed this message
    already_routed = await rd.get(dedup_key)
    if already_routed == 'bot':
        print(f'DEDUP [{event.chat_id}] skipping — bot path already routed: {msg_text[:40]}', flush=True)
        await rd.aclose()
        return

    # Claim this message for telethon path
    await rd.set(dedup_key, 'telethon', ex=30)

    await rd.xadd('telegram:incoming', data, maxlen=1000)
    await rd.xadd('telegram:log', data, maxlen=5000)
    await rd.aclose()

    if is_group and msg_text:
        safe = re.sub(r'[/\s]+', '_', chat_title)[:50]
        date = datetime.now().strftime('%Y-%m-%d')
        with open(os.path.join(WIKI_DIR, f'{safe}_{date}.md'), 'a') as f:
            f.write(f'**[{event.date.strftime("%H:%M")}] {sender_name} {sender_last}:** {msg_text}\n\n')

    print(f'IN [{event.chat_id}] {sender_name}: {msg_text[:60]}', flush=True)

async def outgoing_loop():
    rd = aioredis.Redis(host='localhost', port=6379, decode_responses=True)
    while True:
        try:
            msgs = await rd.xreadgroup('claude-agents', 'sender', {'telegram:outgoing': '>'}, count=1, block=2000)
            for stream, items in msgs:
                for msg_id, data in items:
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
                        await rd.xack('telegram:outgoing', 'claude-agents', msg_id)
                    except Exception as e:
                        print(f'SEND ERR: {e}', flush=True)
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
