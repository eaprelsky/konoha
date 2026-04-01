---
name: Don't hallucinate business processes
description: Only state what is confirmed by data, don't guess or infer business process steps
type: feedback
---

Don't guess or infer business processes that aren't explicitly documented. Only state what is directly confirmed by data from Yonote/Tracker/Bitrix.

**Why:** Claude incorrectly guessed the next step in the sales process. The actual process (feature list → КП by Aleksey → Tracker task) was not something that could be derived from the data — it required domain knowledge.

**How to apply:** When answering about business status, report only what the data shows. If asked "what's next?" — say "I don't know the process, let me check" rather than guessing. Over time, learn the processes from context/wiki and the skills in /opt/shared/comind-template/.claude/skills/.
