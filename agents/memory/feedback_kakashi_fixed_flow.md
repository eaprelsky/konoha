---
name: kakashi:fixed flow — DECOMMISSIONED (#794 bootstrap)
description: Legacy. The kakashi:fixed → Shino → Hinata mandatory post-fix gate is decommissioned as of #794. Shino/Hinata are optional QA specialists activated only on explicit reviewer request.
type: feedback
---

# DECOMMISSIONED — #794 Bootstrap (2026-05-12)

The mandatory post-fix flow `kakashi:fixed → Shino → Hinata` is decommissioned.

Replacement process:
- Kakashi implements fix → submits to Shikadai for review → Shikadai decides whether testing is needed.
- Shino/Hinata are optional; Shikadai may explicitly request: `konoha_send(to=shino, text="Please verify issue #N — commit <hash>.")`.
- No automatic QA gate after every ordinary fix.

Legacy note archived for reference only. Do NOT follow it in the Developer→Reviewer pipeline.
