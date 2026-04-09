#!/usr/bin/env python3
"""Send a message to Telegram via Redis stream. Usage: tg-send.py <chat_id> <text> [reply_to]"""
import sys, redis

r = redis.Redis()
fields = {'chat_id': sys.argv[1], 'text': sys.argv[2]}
if len(sys.argv) > 3 and sys.argv[3]:
    fields['reply_to'] = sys.argv[3]
msg_id = r.xadd('telegram:bot:outgoing', fields)
print(msg_id.decode())
