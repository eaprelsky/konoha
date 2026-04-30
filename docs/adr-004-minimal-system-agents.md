# ADR-004: Minimal System Agents And Workflow-Defined Capabilities

Status: accepted
Date: 2026-04-30

## Context

Konoha started as a named multi-agent system where many capabilities were represented by durable Naruto-style agents: bot/user Telegram agents, development agents, knowledge agents, external-source agents, and operator aliases. That helped bootstrap the system, but it does not scale to customer deployments.

The target product should not require a large predefined agent fleet. Customer-visible behavior must be explainable as eEPC workflows: events, functions, business roles, documents, information systems, gateways, and assignment policies.

## Decision

Konoha's mandatory system-agent footprint is reduced conceptually to:

- `tsunade` / `Советник`: the core product assistant and workflow operator.
- Optional `kiba` / `Системный монитор`: reliability monitoring and recovery, only where the deployment needs an active monitoring actor.

All other named agents are compatibility/runtime actors or optional workers. They must not define product architecture by themselves.

## Target Model

Separate these concepts explicitly:

| Concept | Meaning |
|---|---|
| Runtime worker | A process capable of executing assigned work, e.g. a coding CLI, LLM worker, or human-operated external bus client. |
| Channel connector | Messenger/account/bot/user-account adapter that ingests and emits messages. |
| Business role | Responsibility in a workflow, e.g. `sales_owner`, `test_lead`, `knowledge_curator`. |
| Assignment policy | Mapping from a business role to a human, runtime worker, team, or strategy. |
| Information system | External system used by workflow functions, e.g. Telegram, GitHub, Yonote, CRM, KB store. |
| Document | Function input: prompt, instruction, policy, checklist, credential reference, or runbook. |

A workflow function may be executed by an agent, person, or system adapter, but the workflow owns the business semantics.

## Implications By Legacy Agent

| Legacy alias | Target architectural home |
|---|---|
| Naruto / bot-account agent | Messenger connector plus workflow-triggered response functions. |
| Sasuke / user-account agent | Messenger connector plus routing/classification workflows. |
| Kakashi, Guy, Shino, Hinata | Optional development workers assigned to SDD/harness workflow roles. |
| Jiraiya | Knowledge-base module plus workflow-defined ingestion/curation rules. |
| Mirai | External-source connector/classifier, not a durable autonomous agent by default. |
| Ino, Inojin | Optional situational roles/workers, not seeded core system agents. |
| Shikadai | Optional architecture decomposition/review worker assigned through workflow or operator dispatch. |
| Shikamaru, Itachi | External operator/bus-client scenario, not seeded system agents. |
| Kiba / Akamaru | Optional system monitor; some monitoring can become workflow-driven, but deployment-specific probes may remain operational infrastructure. |

## Messenger Architecture Direction

Messenger integration must not be modeled as one hardcoded agent per Telegram account. Target shape:

```text
Messenger account / bot / user session
  -> channel connector
  -> universal filtering/classification
  -> workflow event
  -> workflow functions with roles/documents/IS adapters
  -> outbound connector action
```

This supports many messengers, many accounts, many bots, and many workflows sharing the same account.

## Security Direction

Credentials are not normal instruction documents. Workflows may reference credential resources, but secrets must live in scoped secret stores or connector profiles. Function documents may describe which credential/profile is required, but must not contain raw tokens.

## Compatibility

Existing runtime ids, systemd units, tmux sessions, Redis streams, and watchdogs may keep legacy names until compatibility-safe migrations are completed. They are implementation details and should not appear in product-facing workflow definitions, role ids, or demo UI.

Compatibility-safe renaming is tracked separately in #620.

## Consequences

- New product capabilities should be modeled workflow-first.
- New durable system agents require architectural justification.
- Optional workers are launched on demand through assignment policies and lifecycle profiles.
- UI should evolve from “manage a fleet of named agents” toward “manage roles, workflows, connectors, worker pools, and assignments”.
- Hardcoded knowledge, messenger, and development agent behavior should be migrated into visible workflows and documents.
