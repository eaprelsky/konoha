# Roadmap

Konoha's architecture roadmap focuses on making the constructor-to-runtime loop
reliable before broad extraction or production release claims.

## Current Direction

- Keep workflow lifecycle, validation, deployment, runtime effects, recovery,
  and observability behind durable contracts.
- Preserve the AI constructor golden path: create, validate, deploy, run, and
  assign the first work item.
- Keep Action Spine generic boundaries separate from Konoha host vocabulary
  until package extraction gates are satisfied.
- Keep PostgreSQL read rollout staged by entity and blocked by consistency
  evidence.
- Keep optional agents, browsers, and heavy MCP packs bounded or on-demand.

## Release Readiness

Workflow Engine release signoff is governed by reviewed repository gates:

- preflight tiers;
- rollback/recovery runbook;
- constructor/runtime release checklist;
- golden-path acceptance;
- production readiness gate.

## Package Extraction

Action Spine package extraction remains a future step. The public boundary is
documented, but runtime adapters and Konoha-specific action vocabulary stay in
the main application until semantic and release gates are complete.
