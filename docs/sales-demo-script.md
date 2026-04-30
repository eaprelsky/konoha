# Sales Workflow Demo Script

This demo starts the canonical sales lead workflow through the assistant
`case.start` contract. It does not call a side router or send production
notifications.

Assistant request:

```text
Запусти демо продаж: создай прогон процесса lead-qualification для Telegram-лида "Нужен AI ассистент для заявок и КП" и открой мониторинг.
```

Expected assistant action payload:

```json
{
  "reply": "Запускаю демо продаж по Telegram-лиду.",
  "start_case": {
    "process_id": "lead-qualification",
    "subject": "Demo Telegram lead",
    "payload": {
      "chat_title": "coMind Лиды",
      "text": "Нужен AI ассистент для заявок и КП",
      "source": "demo"
    }
  }
}
```

Expected result:

- `case.start` receipt is `succeeded`.
- UI action navigates to `/monitor?case_id=<case_id>`.
- The next pending work item is `Разобрать входящий сигнал`.
- The assignee is the business role `lead_triage_specialist`, not a runtime
  alias such as `sasuke`.
