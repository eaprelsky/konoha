# BPMS Program Dependency Graph

Issue #752 defines the execution order for the BPMS architecture program under
epic #672. The machine-readable source of truth is
`docs/bpms-program-dependency-graph.json`.

This plan covers #672-#751 and the follow-up reliability/resource gates called
out during review. It is intentionally ordered to prevent downstream Action
Spine or workflow runtime refactors from starting before test isolation,
resource budgets, lifecycle semantics, and validation gates are in place.

## Milestones

| Milestone | Purpose | Issues | Depends on | Definition of done |
| --- | --- | --- | --- | --- |
| M0 Lean runtime baseline | Keep host stable before BPMS refactors increase event, browser, agent, or MCP load. | #752 plus follow-ups #757, #760, #761, #762, #763, #768, #774, #777, #778, #780, #781, #785, #790, #791, #792, #794 | none | Budget/profile contract reviewed; always-on agents/MCPs bounded; two-role Developer -> Reviewer process active. |
| M1 Environment isolation | Make staging/test safe before workflow engine behavior changes. | #682, #733-#736, #749-#751, #686 | M0 | Tests cannot write prod Redis/PG; staging smoke runs without prod connectors/fleet; rollback/release runbooks exist. |
| M2 Lifecycle and validation | Define executable workflow states and block unsafe case starts. | #673, #674, #687-#697 | M1 | Lifecycle is persisted; `case.start` is gated; validation taxonomy covers graph, gateway, trigger, adapter, document, role, and auth readiness. |
| M3 Durable constructor edits | Move assistant/editor mutations onto durable Action Spine executors. | #675, #676, #698-#709 | M2 | Atomic patch service exists; preview vs commit is explicit; element/flow/trigger executors persist audited state. |
| M4 Deployment and effects | Make deploy, subscriptions, outbox effects, and real dispatch explicit. | #677-#679, #710-#724 | M2, M3 | Deploy is transactional; deployed snapshots own subscriptions; outbox handles retry/dead-letter/recovery; dispatch receipts prove target reachability. |
| M5 Runtime correctness and operations | Stabilize transition planning, observability, recovery, audit, retention, and PG_READ readiness. | #680, #681, #683, #725-#740 | M4 | Pure transition planner exists; effect boundary is explicit; monitor/recovery/audit views work; PG_READ is entity-scoped and gated. |
| M6 Acceptance and extraction | Prove constructor -> deploy -> run -> assigned work item before package extraction. | #684, #685, #741-#748 | M5 | Golden-path and negative suites pass; #618 extraction checklist is updated and remains blocked until semantics are stable. |

## Critical Path

```text
#776 -> #757 -> #760/#761 -> #780/#781/#777/#778/#785
  -> #753/#682 -> #673/#674 -> #675/#676
  -> #677/#678/#679 -> #680/#681/#754/#683
  -> #685 -> #684 -> #618
```

Rule: any issue that increases always-on agents, MCP servers, browser contexts,
Redis consumers, or event volume must depend on M0 budget/profile work and must
include a before/after resource note.

## Capability Dependency Table

| Capability issue | Depends on | Blocks |
| --- | --- | --- |
| #673 executable lifecycle | #682, #733-#736 | #687-#691, #677, #678, #679, #685 |
| #674 validation contract | #682, #733-#736 | #692-#697, #675, #676, #677, #685 |
| #675 durable assistant edits | #674, #698, #703 | #699-#702, #685 |
| #676 Action Spine mutation executors | #674, #698, #703 | #704-#709, #675, #684 |
| #677 deployment service | #673, #674, #675, #676 | #710-#714, #678, #685 |
| #678 runtime outbox | #677, #715 | #716-#720, #681, #685 |
| #679 role readiness and dispatch | #674, #678 | #721-#724, #685 |
| #680 deterministic state-machine core | #677, #678 | #725-#728, #681, #683, #685 |
| #681 observability and recovery | #678, #680 | #729-#732, #686 |
| #682 test storage isolation | #757, #760, #761 | #733-#736, #673, #674, #685 |
| #683 Redis/PostgreSQL consistency | #680, #681 | #737-#740, #685, #686 |
| #684 Action Spine extraction readiness | #685, #741-#743 | #618, #744 |
| #685 golden-path acceptance | #673-#681, #683 | #684, #686, #618 |
| #686 release gate and runbook | #682, #685, #749-#751, #787, #788, #789 | production readiness |

The full issue-level table, including #687-#751 detailed execution issues, is
in `docs/bpms-program-dependency-graph.json`.

## Parallel Workstreams

| Workstream | Can run after | Must join before | Issues |
| --- | --- | --- | --- |
| Runtime diet | immediately, one issue at a time under current delivery policy | M1 | #760, #761, #762, #763, #768, #774, #777, #778, #780, #781, #785, #790-#794 |
| Test isolation | M0 budget/profile gates | M2 | #682, #733-#736, #749-#751 |
| Lifecycle/validation | M1 | M3 | #673, #674, #687-#697 |
| Durable edits/Action Spine | M2 | M4 | #675, #676, #698-#709 |
| Deploy/outbox/dispatch | M2 and M3 | M5 | #677-#679, #710-#724 |
| Operations/persistence | M4 | M6 | #680, #681, #683, #725-#740, #754, #787-#789 |
| Acceptance/extraction | M5 | release | #684, #685, #741-#748, #618 |

## Role Ownership

| Responsibility | Owner |
| --- | --- |
| Default implementation | Kakashi |
| Architecture/code review and closure recommendation | Shikadai |
| Test-plan escalation | Shino |
| Bounded browser/TestBench execution | Hinata |
| Runtime pressure and health monitoring | Kiba/Akamaru |
| Issue sequencing, close requests, release communication | Naruto |
| Security/audit escalation | Ibiki |

Specialist agents are escalation tools, not mandatory serial stages. The default
delivery path remains Developer -> Reviewer.

## Extraction Gate For #618

#618 stays blocked until #684, #685, and #741-#744 are complete. Extraction must
not begin while workflow lifecycle, validation, durable edits, deploy/outbox
effects, golden-path tests, and Action Spine port boundaries are still moving.

## Update Policy

- If a new BPMS issue is added, place it in exactly one milestone and add
  `depends_on` and `blocks` entries in the JSON.
- If an issue touches always-on runtime footprint, link it to M0 budget/profile
  work and include before/after resource evidence.
- If an issue changes executable semantics, add or update the golden-path and
  negative acceptance gates before moving #618.
