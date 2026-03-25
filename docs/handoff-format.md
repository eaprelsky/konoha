# Konoha Bus — Handoff Document Format

When delegating tasks between agents, use this structured format for the `text` field in messages with `type: "task"` or `type: "result"`.

## Task Handoff (type: "task")

```
TASK: [short title]

CONTEXT:
[What was done before, why this task is needed]

SCOPE:
[Specific deliverable — what needs to be done]

FILES:
[List of relevant files, if any]

CONSTRAINTS:
[Requirements, deadlines, things to avoid]

ATTACHMENTS:
[Reference any files in the attachments[] field]
```

### Example

```json
{
  "from": "naruto",
  "to": "sasuke",
  "type": "task",
  "text": "TASK: Send weekly report PDF to Yegor\n\nCONTEXT:\nGenerated weekly report in /opt/shared/attachments/report-2026-w13.pdf\n\nSCOPE:\nSend the PDF to Yegor via Telegram user account (chat_id: OWNER_TG_ID)\n\nFILES:\n/opt/shared/attachments/report-2026-w13.pdf\n\nCONSTRAINTS:\nSend via Telethon (user account), not bot",
  "attachments": [{
    "name": "report-2026-w13.pdf",
    "path": "/opt/shared/attachments/report-2026-w13.pdf",
    "mime": "application/pdf"
  }]
}
```

## Result Handoff (type: "result")

```
RESULT: [short title]

SUMMARY:
[What was done]

OUTPUT:
[Key results, data, findings]

FILES CHANGED:
[List of modified/created files]

STATUS: [DONE | PARTIAL | BLOCKED]

NEXT STEPS:
[What the requesting agent should do next, if anything]
```

### Example

```json
{
  "from": "sasuke",
  "to": "naruto",
  "type": "result",
  "text": "RESULT: Weekly report sent\n\nSUMMARY:\nSent report-2026-w13.pdf to Yegor via Telethon.\n\nOUTPUT:\nMessage delivered, Yegor reacted with thumbs up.\n\nSTATUS: DONE\n\nNEXT STEPS:\nNone — task complete."
}
```

## Multi-Phase Handoff

For complex tasks that pass through multiple agents:

```
HANDOFF: [previous-agent] -> [next-agent]

PHASE: [current phase name]

CONTEXT:
[Summary of what was done in previous phase]

FINDINGS:
[Key discoveries or decisions]

FILES:
[Files created/modified so far]

OPEN QUESTIONS:
[Unresolved items for next agent]

RECOMMENDATIONS:
[Suggested approach for next phase]
```

## Status Updates (type: "status")

Short-form updates for progress tracking:

```json
{
  "from": "sasuke",
  "to": "naruto",
  "type": "status",
  "text": "Telegram monitoring active. 3 messages processed in last hour. No action required."
}
```

## Best Practices

1. **Keep text concise** — agents have limited context windows
2. **Reference files by path** — don't inline large content, use attachments
3. **Include STATUS** — always state DONE/PARTIAL/BLOCKED in results
4. **Specify constraints** — which channel to use, what to avoid
5. **Use message types** — `task` for delegation, `result` for completion, `status` for updates
