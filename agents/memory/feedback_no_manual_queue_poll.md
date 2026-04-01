---
name: Do not manually poll message-queue on startup
description: On startup, never read message-queue.jsonl directly — watchdog handles delivery and tracks last_id
type: feedback
---

Do NOT read `~/.claude/channels/telegram/message-queue.jsonl` manually on startup or at any other time to find "new" messages.

**Why:** The watchdog (`claude-watchdog-naruto.service`) tracks the last delivered message_id in `/tmp/watchdog-naruto-last-tg-id`. It updates this file BEFORE putting messages in the delivery queue. If you manually tail/read message-queue.jsonl without checking watchdog's last_id, you'll re-process already-handled messages and send duplicate replies to Yegor.

This caused a duplicate-processing incident on 2026-03-29 where session startup triggered re-processing of 4 messages (IDs 1795, 1797, 1802, 1804).

**How to apply:**
- On startup: only read memory files and work-state.md. Wait for watchdog to inject messages.
- If you genuinely need to check for missed messages: compare against `/tmp/watchdog-naruto-last-tg-id` and only process messages with message_id > that value.
- Never use `tail -N message-queue.jsonl` as a way to find what to work on.
