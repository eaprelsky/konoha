---
name: Guy delegation pattern
description: What tasks to delegate to Guy (Haiku) vs keep with Kakashi (Sonnet)
type: project
---

Agreed delegation pattern (2026-03-31, Kakashi + Naruto):

**Guy (Haiku) — delegate:**
- Documentation: update agents/README.md, add sections to agent CLAUDE.md files
- New agent scaffolds (CLAUDE.md + mcp config)
- New adapters following existing template (bitrix24/telegram pattern)
- Search-and-replace, formatting tasks

**Kakashi (Sonnet) — keep:**
- Architectural decisions (gateway operators, saga pattern, etc.)
- Changes to runtime.ts, redis.ts — critical path
- Non-trivial bug debugging

**Why:** Guy runs on Haiku = cheaper tokens, lower RAM. Can't run Guy + Inojin simultaneously (RAM 88% critical).

**How to apply:** When queuing tasks for Kakashi, tag "→ Guy" for adapter/doc tasks. Wait for Inojin to finish before starting Guy.
