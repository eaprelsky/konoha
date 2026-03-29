#!/usr/bin/env python3
"""Poll telegram:bot:incoming (consumer group sasuke) and print new messages as JSON."""
import redis
import json
import sys

r = redis.Redis(decode_responses=True)

GROUP = 'sasuke'
CONSUMER = 'sasuke-main'
STREAM = 'telegram:bot:incoming'
COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 10

# Read new messages from consumer group
results = r.xreadgroup(GROUP, CONSUMER, {STREAM: '>'}, count=COUNT, block=0)

if not results:
    print("No new messages.")
    sys.exit(0)

for stream_name, messages in results:
    for msg_id, fields in messages:
        # Acknowledge
        r.xack(STREAM, GROUP, msg_id)
        fields['_msg_id'] = msg_id
        print(json.dumps(fields, ensure_ascii=False))
