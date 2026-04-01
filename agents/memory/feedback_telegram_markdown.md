---
name: Telegram messages use plain text
description: Send Telegram messages as plain text, not MarkdownV2 — special chars get mangled
type: feedback
---

Send Telegram messages as plain text. Do NOT use MarkdownV2 formatting.

**Why:** Special characters in MarkdownV2 get mangled when sent through tg-send.py (Redis → bot API). Plain text works reliably.

**How to apply:** Use `python3 /home/ubuntu/tg-send.py <chat_id> 'plain text message'`. No asterisks for bold, no underscores. Write naturally.
