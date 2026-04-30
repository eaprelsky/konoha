# Knowledge source classification

`workflows/knowledge/source-classification.json` keeps the intake rules as workflow document seeds, not hidden prompt code.

The primary document is `knowledge.source.classification.policy`. It tells the curator how to classify five common source types:

- `meeting_transcript`: ingest durable decisions, owners, deadlines, requirements, or risks; escalate consent and confidentiality concerns.
- `chat_thread`: ingest decisions, incidents, agreements, and reusable context; ignore greetings, duplicate notifications, and transient coordination.
- `proposal`: ingest approved scope, assumptions, terms, risks, and client commitments; escalate pricing or legal ambiguity.
- `adr`: ingest accepted or superseded decisions with context, alternatives, consequences, and owner.
- `external_article`: summarize curated external references; escalate licensing, paywall, or trust concerns.

The companion document is `knowledge.source.classification.output`. It defines the structured result expected from the classifier:

```json
{
  "source_type": "meeting_transcript | chat_thread | proposal | adr | external_article | unknown",
  "intake_decision": "ingest | summarize_only | ignore | escalate",
  "sensitivity": "public | internal | confidential | restricted",
  "confidence": 0.0,
  "summary_required": true,
  "extraction_scope": ["decisions", "owners", "risks"],
  "evidence": ["source-local fact"],
  "escalation_reason": null,
  "ignored_reason": null
}
```

Functions that perform classification attach both documents. Escalation review attaches the policy document so the lead sees the same rules used by the classifier.
