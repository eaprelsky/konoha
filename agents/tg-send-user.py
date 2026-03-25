#!/usr/bin/env python3
"""Send a message via Telethon user account (Sasuke channel). Usage: tg-send-user.py <chat_id> <text> [reply_to]"""
import sys, redis

r = redis.Redis()
fields = {'chat_id': sys.argv[1], 'text': sys.argv[2]}
if len(sys.argv) > 3 and sys.argv[3]:
    fields['reply_to'] = sys.argv[3]
msg_id = r.xadd('telegram:outgoing', fields)
print(msg_id.decode())
