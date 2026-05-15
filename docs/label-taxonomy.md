# Konoha GitHub Label Taxonomy

Canonical label system for the Konoha delivery workflow. Replaces ad-hoc labels
and agent triggers (`delegate:teamlead`, `kakashi-ready`, etc.) with a stable,
machine-readable contract.

Issue: [#793](https://github.com/eaprelsky/konoha/issues/793)

## Taxonomy categories

### Priority — `priority:p<N>`

Mandatory on every issue. Determines execution order.

| Label | Description | Color |
|---|---|---|
| `priority:p0` | Blocking — fix/deliver immediately | `#b60205` |
| `priority:p1` | Important — take next | `#e4312b` |
| `priority:p2` | Normal backlog | `#fbca04` |
| `priority:p3` | Nice to have — do last | `#0e8a16` |

Conflicts: an issue MUST have exactly one priority.

### Workflow state — `state:<phase>`

Tracks the issue's position in the delivery pipeline. Mutually exclusive —
exactly one state label per issue at any time.

| Label | Description | Color |
|---|---|---|
| `state:triage` | New — needs classification | `#ededed` |
| `state:ready-for-dev` | Spec complete — Kakashi can implement | `#0052cc` |
| `state:in-progress` | Implementation active | `#1d76db` |
| `state:ready-for-review` | Code complete — Shikadai reviews | `#5319e7` |
| `state:ready-for-test` | Review passed — Hinata tests | `#0075ca` |
| `state:blocked` | Cannot proceed — see `blocked:*` for reason | `#d93f0b` |
| `state:done` | Delivered / closed | `#0e8a16` |

State transitions (happy path):
```
triage → ready-for-dev → in-progress → ready-for-review → ready-for-test → done
```

Any state can transition to `blocked`. `blocked` returns to the state it left.

Guardrails:
- `state:ready-for-dev` + `state:ready-for-review` = CONFLICT
- `state:done` + any other state = CONFLICT
- `state:blocked` SHOULD have a `blocked:*` reason label
- `state:in-progress` SHOULD have an `agent:*` assignment

### Component area — `area:<component>`

What part of the system the work touches. An issue may have multiple areas.

| Label | Description | Color |
|---|---|---|
| `area:backend` | Server, API, Redis, Postgres | `#0052cc` |
| `area:frontend` | Dashboard, UI | `#1d76db` |
| `area:messenger` | Telegram connectors, chat routing | `#1d76db` |
| `area:mcp` | MCP server, tool contracts | `#ededed` |
| `area:action-spine` | /act endpoint, action registry | `#0e8a16` |
| `area:testbench` | Test infrastructure, evals | `#5319e7` |
| `area:devops` | Deploy, tmux, watchdog, monitoring | `#5319e7` |
| `area:docs` | Documentation, runbooks | `#0075ca` |
| `area:i18n` | Internationalisation / localisation | `#c5def5` |

### Work type — `type:<kind>`

Nature of the work. Exactly one per issue.

| Label | Description | Color |
|---|---|---|
| `type:bug` | Something is broken | `#d73a4a` |
| `type:feature` | New capability | `#a2eeef` |
| `type:enhancement` | Improve existing capability | `#a2eeef` |
| `type:refactor` | Restructure without behaviour change | `#ededed` |
| `type:tech-debt` | Deferred cleanup / modernization | `#fbca04` |
| `type:architecture` | Cross-cutting design / system structure | `#5319e7` |
| `type:security` | Security-related work | `#b60205` |
| `type:docs` | Documentation only | `#0075ca` |
| `type:test` | Test coverage / test infra | `#0e8a16` |

### Risk / classification — `risk:<level>`

Optional — flags issues needing special attention.

| Label | Description | Color |
|---|---|---|
| `risk:critical` | Critical bug — potential data loss or outage | `#b60205` |
| `risk:regression` | Previously working behaviour broken | `#e11d48` |

### Agent assignment — `agent:<name>`

Which agent is currently responsible. Informs routing but does NOT replace
workflow state — state labels drive the pipeline, agent labels drive dispatch.

| Label | Description | Color |
|---|---|---|
| `agent:kakashi` | Developer — implementation | `#ededed` |
| `agent:shikadai` | Reviewer — architecture / code review | `#5319e7` |
| `agent:hinata` | Tester — QA / acceptance | `#0075ca` |
| `agent:shino` | Test author — writes test cases | `#0e8a16` |
| `agent:naruto` | Orchestrator — delegation / triage | `#d93f0b` |

Guardrails:
- `agent:kakashi` is appropriate for `state:ready-for-dev` and `state:in-progress`
- `agent:shikadai` is appropriate for `state:ready-for-review`
- `agent:hinata` is appropriate for `state:ready-for-test`

### Blocker reason — `blocked:<reason>`

Required when `state:blocked` is set. Explains why work cannot proceed.

| Label | Description | Color |
|---|---|---|
| `blocked:external` | Waiting on external system / API / person | `#d93f0b` |
| `blocked:dependency` | Blocked by another Konoha issue | `#d93f0b` |
| `blocked:needs-info` | Needs clarification before proceeding | `#d93f0b` |

## Legacy label migration

### Migration map

| Legacy label | Canonical replacement | Action |
|---|---|---|
| `P0`, `P0: critical` | `priority:p0` | Replace |
| `P1`, `P1: high` | `priority:p1` | Replace |
| `P2`, `P2: medium` | `priority:p2` | Replace |
| `P3`, `P3: low` | `priority:p3` | Replace |
| `delegate:teamlead` | (none) | **Remove** — priority now drives ordering |
| `delegate:done` | `state:done` | Replace |
| `delegate:architect` | `agent:shikadai` | Replace |
| `kakashi-ready` | `state:ready-for-dev` | Replace |
| `kakashi-batch` | (none) | **Remove** — batching is implementation detail |
| `awaiting-test` | `state:ready-for-test` | Replace |
| `"awaiting-test"` | `state:ready-for-test` | Replace (remove quoted duplicate) |
| `test-cases-written` | (none) | **Remove** — integrated into definition-of-ready |
| `needs-testing` | `state:ready-for-test` | Replace |
| `blocked` | `state:blocked` | Replace |
| `bug` | `type:bug` | Replace |
| `feature` | `type:feature` | Replace |
| `enhancement` | `type:enhancement` | Replace |
| `refactor` | `type:refactor` | Replace |
| `architecture` | `type:architecture` | Replace |
| `tech-debt` | `type:tech-debt` | Replace |
| `security` | `type:security` | Replace |
| `documentation` | `type:docs` | Replace |
| `backend` | `area:backend` | Replace |
| `frontend` | `area:frontend` | Replace |
| `messenger` | `area:messenger` | Replace |
| `mcp` | `area:mcp` | Replace |
| `action-spine` | `area:action-spine` | Replace |
| `testbench` | `area:testbench` | Replace |
| `devops` | `area:devops` | Replace |
| `workflow` | (none) | **Remove** — too broad, use `type:architecture` or specific area |
| `monitoring` | `area:devops` | Replace |
| `smoke` | `type:test` | Replace |
| `test-failure` | `type:bug` | Replace |
| `critical` | `risk:critical` | Replace |
| `regression` | `risk:regression` | Replace |
| `i18n` | `area:i18n` | Replace |

### Labels kept as-is (standard GitHub)

`good first issue`, `help wanted`, `invalid`, `duplicate`, `wontfix`, `question`

## Controller mapping

How each agent interprets labels for dispatch decisions:

| Agent | Dispatch trigger | Action |
|---|---|---|
| Naruto (orchestrator) | `state:triage` | Classify: set priority, state, type, area, agent |
| Naruto (orchestrator) | `state:blocked` | Review blocker reason, unblock or escalate |
| Kakashi (developer) | `state:ready-for-dev` + `agent:kakashi` | Take and implement |
| Kakashi (developer) | `state:in-progress` + `agent:kakashi` | Continue / complete implementation |
| Shikadai (reviewer) | `state:ready-for-review` | Review, approve or request changes |
| Shikadai (reviewer) | `agent:shikadai` + any open state | Architecture review / decomposition |
| Hinata (tester) | `state:ready-for-test` | Run tests, verify acceptance criteria |
| Shino (test author) | `agent:shino` + pre-implementation | Write test cases in comments |

## Automation guardrails

Rules enforced by the label application/migration scripts:

1. **Single priority**: an issue MUST have exactly one `priority:p*` label
2. **Single state**: an issue MUST have exactly one `state:*` label  
3. **Single type**: an issue SHOULD have exactly one `type:*` label
4. **No conflicting states**: `state:ready-for-dev` and `state:ready-for-review` cannot coexist
5. **Blocked requires reason**: if `state:blocked`, at least one `blocked:*` SHOULD be present
6. **Done is terminal**: `state:done` cannot coexist with any other `state:*`
7. **Agent matches state**: `agent:*` should be consistent with workflow state
8. **No legacy labels**: after migration, legacy labels (P0-P3, delegate:*, kakashi-*, awaiting-test, etc.) must not appear on open issues

## Files

| File | Purpose |
|---|---|
| `docs/label-taxonomy.md` | This document — canonical reference |
| `scripts/gh-labels-apply.sh` | Create/update all canonical labels via `gh label` |
| `scripts/gh-labels-migrate.sh` | Migrate existing open issues from legacy to canonical labels |
