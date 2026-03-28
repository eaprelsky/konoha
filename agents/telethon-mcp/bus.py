"""Bus v4: async Redis to not block Telethon event loop."""
from telethon import TelegramClient, events
import asyncio
import redis.asyncio as aioredis
import redis as sync_redis
import re
import os
import json
from datetime import datetime

SESSION = '/opt/shared/telegram_session'
WIKI_DIR = '/opt/shared/wiki/group-chats'
os.makedirs(WIKI_DIR, exist_ok=True)

# Sync redis for stream group creation only
sr = sync_redis.Redis(host='localhost', port=6379, decode_responses=True)
for s in ['telegram:incoming', 'telegram:outgoing', 'telegram:log', 'telegram:commands', 'telegram:reaction_updates']:
    try:
        sr.xgroup_create(s, 'claude-agents', id='0', mkstream=True)
    except:
        pass
sr.close()

client = TelegramClient(SESSION, 2040, 'b18441a1ff607e10a989891a5462e627')

@client.on(events.Raw)
async def on_raw(event):
    from telethon.tl.types import UpdateBotMessageReaction, ReactionEmoji
    if not isinstance(event, UpdateBotMessageReaction):
        return
    try:
        peer = event.peer
        chat_id = (getattr(peer, 'channel_id', None) or
                   getattr(peer, 'chat_id', None) or
                   getattr(peer, 'user_id', None))

        def extract_emoji(reactions):
            if not reactions:
                return []
            result = []
            for r in reactions:
                reaction = getattr(r, 'reaction', None)
                if isinstance(reaction, ReactionEmoji):
                    result.append(reaction.emoticon)
                elif reaction is not None and hasattr(reaction, 'document_id'):
                    result.append(f'custom:{reaction.document_id}')
            return result

        actor = getattr(event, 'actor', None)
        actor_id = str(getattr(actor, 'user_id', 0) if actor else 0)

        data = {
            'chat_id': str(chat_id),
            'msg_id': str(event.msg_id),
            'actor_id': actor_id,
            'new_reaction': json.dumps(extract_emoji(getattr(event, 'new_reactions', []))),
            'old_reaction': json.dumps(extract_emoji(getattr(event, 'old_reactions', []))),
            'timestamp': datetime.utcnow().isoformat(),
        }

        rd = aioredis.Redis(host='localhost', port=6379, decode_responses=True)
        await rd.xadd('telegram:reaction_updates', data, maxlen=500)
        await rd.aclose()

        print(f'REACT [{chat_id}] msg={event.msg_id} actor={actor_id} new={data["new_reaction"]}', flush=True)
    except Exception as e:
        print(f'REACT ERR: {e}', flush=True)


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

    data = {
        'chat_id': str(event.chat_id),
        'chat_title': chat_title,
        'is_group': '1' if is_group else '0',
        'msg_id': str(event.id),
        'sender_id': str(getattr(sender, 'id', 0)),
        'sender_name': f'{sender_name} {sender_last}'.strip(),
        'sender_username': getattr(sender, 'username', '') or '',
        'text': msg_text,
        'reply_to': str(event.reply_to.reply_to_msg_id) if event.reply_to else '',
        'timestamp': event.date.isoformat(),
    }
    if attachment_path:
        data['attachment_path'] = attachment_path
        data['attachment_kind'] = attachment_kind
    if attachment_name:
        data['attachment_name'] = attachment_name

    # Async Redis write
    rd = aioredis.Redis(host='localhost', port=6379, decode_responses=True)
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
    await client.connect()
    me = await client.get_me()
    print(f'Bus v4 (async redis): {me.first_name} (ID: {me.id})', flush=True)

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
