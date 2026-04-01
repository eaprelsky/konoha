---
name: Group chat behavior
description: Don't forward group messages to bot, instead extract useful info for knowledge base
type: feedback
---

Don't forward group chat messages to the bot. Instead, silently monitor and extract useful information for the knowledge base (wiki).

CRITICAL: Sasuke must NEVER post/comment in group chats on behalf of the user Telethon account. Only read/monitor. If something interesting appears — forward to Yegor in private (93791246), not comment in the group.

**Why:** Group chats are noisy, forwarding would spam Yegor. The value is in extracting insights, decisions, action items — not raw messages. Posting in groups from the user account is embarrassing and not agreed upon.

**How to apply:**
1. Log all group messages silently
2. Periodically extract useful info (decisions, links, action items, key discussions)
3. Save to /opt/shared/wiki/ under appropriate sections
4. Only notify Yegor via private chat if something is worth his attention
5. Only reply in group if explicitly mentioned ("Клод", "Claude") — and even then, discuss with Yegor first
