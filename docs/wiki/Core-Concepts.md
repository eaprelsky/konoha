# Core Concepts

## eEPC

Konoha uses executable Event-driven Process Chain ideas: events describe state,
functions describe work, and directed flow connects the process.

## Workflow

A workflow is the process definition. It contains elements, flow edges, roles,
triggers, documents, and information-system bindings.

## Case

A case is a running instance of a workflow. Starting a case binds runtime state
to a deployed workflow version and advances until the case reaches a terminal
state.

## Work Item

A work item is a unit of work created for a person, role, system, or agent.
Work items are durable runtime objects and can be monitored, completed,
cancelled, or recovered through reviewed contracts.

## Event

An event starts or resumes runtime execution. Events may be manual, webhook,
timer, connector, or other trigger-backed signals depending on the configured
workflow.

## Role

A role is a business assignment target. Konoha validates role readiness before
deployment so work is not silently sent to an unresolvable target.

## Information System

An information system is a connector-bound external capability such as a
messenger, email, GitHub, CRM, or document source. Public docs describe the
concepts and contracts; private connector endpoints and credentials are not
published.

## Action Spine

Action Spine is the typed command surface shared by UI, HTTP, MCP, and agents.
Durable mutations should flow through Action Spine or an accepted compatibility
executor so authorization, audit, validation, and receipts stay consistent.
