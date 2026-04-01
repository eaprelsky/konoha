---
name: Run tasks in background by default
description: Always use background agents and async bash for long tasks to keep Telegram chat responsive
type: feedback
---

Run long tasks as background agents or async bash processes by default, keeping the Telegram chat responsive.

**Why:** User wants to be able to chat and give new instructions even while tasks are running. Blocking the conversation on a single task is frustrating.

**How to apply:** Use `run_in_background: true` for Agent calls and `run_in_background: true` for long Bash commands. Report results when they complete via new reply (not edit, so the notification pings). For quick operations (<5 sec), foreground is fine.

**Also:** Proactively report when tasks are done — do NOT ask for confirmation first. Yegor complained (2026-03-26) that after being told not to ask for confirmations, the agent swung to the opposite extreme and stopped reporting completions at all. The right behavior is: do the work, then send a completion message unprompted.
