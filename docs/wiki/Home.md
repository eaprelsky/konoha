# Konoha

Konoha is an AI-native BPMS and multi-agent control plane. It helps an
operator describe a business process, turn that description into an executable
eEPC workflow, run cases, assign work to people or agents, and monitor runtime
state through auditable receipts.

This Wiki is the public handbook for the project. It is generated from reviewed
files in `docs/wiki/`; the GitHub Wiki is a published projection, not a
separate source of truth.

## Start Here

- [Quickstart](Quickstart) - run Konoha locally and open the operator UI.
- [Core Concepts](Core-Concepts) - workflow, case, work item, event, role, and
  information system vocabulary.
- [AI Constructor](AI-Constructor) - how assistant requests become executable
  workflows.
- [Architecture Overview](Architecture-Overview) - backend, Action Spine,
  Workflow Engine, adapters, frontend, and agent lifecycle.
- [Operator Handbook](Operator-Handbook) - monitoring, preflight, release, and
  rollback at a high level.
- [Tutorials](Tutorials) - first workflow, first case, and connector examples.
- [Roadmap](Roadmap) - major architecture directions and release gates.
- [FAQ / Troubleshooting](FAQ-Troubleshooting) - common setup and operations
  questions.
- [Public Documentation Policy](Public-Documentation-Policy) - what is allowed
  in the public Wiki.

## What Konoha Provides

- Executable eEPC workflows with events, functions, gateways, roles, documents,
  and information-system bindings.
- Durable constructor-to-runtime flow through server-side Action Spine
  contracts.
- Runtime cases, work items, waits, reminders, subscriptions, and observable
  dispatch effects.
- A React operator workspace for process design, task execution, monitoring,
  knowledge, connectors, documents, and agent management.
- MCP tools and managed agent lifecycle controls for AI-assisted operations.

## Source Of Truth

Use the main repository for reviewed source documentation and implementation:

- `README.md` for concise project orientation.
- `docs/` for architecture, API, release, and operator runbooks.
- `docs/wiki/` for public Wiki source pages.
- GitHub Wiki for the human-friendly published projection.
