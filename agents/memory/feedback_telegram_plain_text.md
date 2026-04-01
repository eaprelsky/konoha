---
name: Telegram plain text formatting
description: Send Telegram messages via Python (not redis-cli) to avoid backslash escaping of special chars
type: feedback
---

При отправке сообщений через Redis telegram:outgoing использовать plain text без экранирования спецсимволов.

**Why:** redis-cli экранирует `!` и другие спецсимволы (добавляет `\` перед ними). Егор видит сообщения со слешами перед восклицательными знаками.

**How to apply:** Отправлять через `python3 /home/ubuntu/tg-send.py <chat_id> '<text>' [reply_to]` — этот скрипт пишет в Redis через Python-клиент, который не экранирует символы. НЕ использовать `redis-cli XADD` для отправки текста.
