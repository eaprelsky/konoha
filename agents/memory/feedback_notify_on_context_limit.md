---
name: Notify Yegor when approaching context limit
description: When agent approaches token/context limit, must send Telegram notification to Yegor via bot
type: feedback
---

When a session is approaching context limits (token exhaustion), notify Yegor via Telegram bot before going silent.

**Why:** Yegor had to manually restart agents after they silently ran out of tokens during an incident (2026-03-30). No warning was sent.

**How to apply:** Implemented in suggest-compact.js hook — sends tg-send.py notification at 50 tool calls (threshold) and every 50 more after that. If building new agents or hooks, include similar early-warning logic.
