---
name: Guy delegation pattern
description: What tasks to delegate to Guy (Haiku) vs keep with Kakashi (Sonnet)
type: project
---

Agreed delegation pattern (2026-03-31, Kakashi + Naruto):

**Guy (Haiku) — delegate:**
- Documentation: update agents/README.md, add sections to agent AGENTS.md files
- New agent scaffolds (AGENTS.md + mcp config)
- New adapters following existing template (bitrix24/telegram pattern)
- Search-and-replace, formatting tasks

**Kakashi (Sonnet) — keep:**
- Architectural decisions (gateway operators, saga pattern, etc.)
- Changes to runtime.ts, redis.ts — critical path
- Non-trivial bug debugging

**Bootstrap (#794):** Guy is NOT part of default issue processing. Only delegate to Guy when a task explicitly requires docs/mechanical work and Kakashi makes an explicit decision to delegate.

**Why:** Guy runs on Haiku = cheaper tokens, lower RAM. Can't run Guy + Inojin simultaneously (RAM 88% critical).

**How to apply:** During bootstrap, do NOT auto-delegate to Guy. Only delegate on explicit Kakashi decision for tasks that are purely mechanical.
