# Architecture Overview

Konoha is currently a modular monolith with explicit boundaries. The primary
backend process mounts the Workflow Engine, Action Spine, bus APIs, adapters,
MCP tools, and static UI.

```text
React operator workspace / HTTP clients / MCP agents
        |
        v
core/src/server.ts  (Bun + Hono composition root)
        |
        +-- modules/workflow-engine/src  workflows, cases, work items, waits
        +-- src/runtime/*                runtime entities and schedulers
        +-- src/action-*                 Action Spine contracts and executor
        +-- src/events/*                 event manager and subscriptions
        +-- src/adapters/*               information-system connectors
        +-- src/redis.ts                 Redis stream bus facade
        +-- src/storage/*                PostgreSQL shadow persistence
        +-- src/agent-lifecycle.ts       managed agent runtime state
        +-- src/mcp.ts                   MCP tools for agents and assistants
```

## Runtime Storage

Redis is the active runtime store for workflow execution, bus streams, cases,
work items, waits, reminders, and runtime effects. PostgreSQL receives shadow
writes for durability, analytics, and future read cutover.

## Workflow Engine

The Workflow Engine owns workflow definitions, validation, deployment, running
cases, work items, waits, subscriptions, reminders, and deterministic state
transitions.

## Action Spine

Action Spine defines typed actions, validation, security policy, and the
execution envelope used by UI, HTTP, MCP, and agents. Generic Action Spine
types and ports are separated from Konoha-specific action vocabulary in the
repository.

## Frontend

The React operator workspace covers process editing, tasks, monitoring,
knowledge, connectors, documents, settings, and agent lifecycle views.

## Agent Lifecycle

Managed agents run under explicit lifecycle profiles. Optional development,
browser, and MCP-heavy paths are bounded or on-demand to keep the core runtime
lean.
