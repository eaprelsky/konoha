---
name: kakashi:fixed flow — notify Shino first
description: After closing a bug fix issue, send kakashi:fixed to Shino BEFORE notifying anyone else. Shino writes test-plan and test-cases, then triggers Hinata himself. Hinata must NOT start without Shino's plan — HARD GATE violation.
type: feedback
---

After closing any issue, the correct notification order is:

1. `konoha_send(to=shino, text="kakashi:fixed issue=N commit=<hash>")` — FIRST
2. `konoha_send(to=naruto, text="[Kakashi] Closed issue #N: ...")` — SECOND (info only, no test trigger)

Shino writes test-plan.md and test-cases.md, then triggers Hinata himself.

**Do NOT** send anything to Hinata directly — Shino owns the QA gate.

**Why:** Hinata was starting tests without a plan, which is a HARD GATE violation per QA pipeline rules. Shino reported this 2026-03-29.

**How to apply:** Every time Kakashi closes a bug fix issue — first message always goes to Shino.
