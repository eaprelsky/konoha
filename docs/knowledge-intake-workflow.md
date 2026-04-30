# Knowledge Intake Workflow

`workflows/knowledge/intake.json` models curated knowledge intake as workflow
state rather than a hardcoded knowledge-agent persona.

The knowledge base is an information system referenced by function metadata:

- `knowledge_base:source.discover`
- `knowledge_base:draft.extract`
- `knowledge_base:entry.publish`

Business roles are stable and deployment-owned:

- `knowledge_intake_lead` scopes candidate sources and starts intake.
- `knowledge_curator` classifies sources and extracts reusable knowledge.
- `knowledge_reviewer` checks correctness, attribution, sensitivity, and duplicates.
- `knowledge_publisher` publishes approved entries.

An optional worker can execute these functions by being assigned to one or more
of those roles. The worker identity is runtime configuration; the workflow must
not name a persona such as Jiraiya as a role.

This slice does not add real ingestion connectors or KB UI changes. Source
access, extraction, and publish operations are workflow metadata until dedicated
connectors are added.
