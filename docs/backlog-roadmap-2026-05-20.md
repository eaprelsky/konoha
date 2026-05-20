# Konoha Backlog Roadmap - 2026-05-20

Scope: all 101 currently open GitHub issues in `eaprelsky/konoha`, from `#618`
through `#812`.

## Review Findings

- GitHub currently shows 101 open issues: 21 `priority:p0`, 59
  `priority:p1`, and 21 `priority:p2`.
- Every open issue has exactly one `priority:p*` label and one `state:triage`
  label in the fetched GitHub API snapshot.
- This roadmap extends the previous `#745-#812` roadmap and uses
  `docs/bpms-program-dependency-graph.md`,
  `docs/bpms-program-dependency-graph.json`, and `docs/lean-baseline-gate.md`
  as the ordering baseline.
- Some issues are higher priority than their prerequisites. The execution order
  below respects architecture dependencies: lean/runtime gates first, then
  staging/test isolation, lifecycle/validation, durable edits, deployment and
  effects, runtime operations, acceptance, and finally Action Spine extraction.

## Gates

1. Do not close any issue without Shikadai reviewer acceptance.
2. `#812` is P0 but paused by Yegor until Codex stabilizes. Keep it visible as
   the first unpause item because terminal/closed cases must not route new work.
3. `#759` is the active P0 lean-runtime epic. Its child work should reduce
   always-on agents, MCPs, browser pools, caches, and host-service pressure
   before broad staging or BPMS runtime expansion.
4. `#672` is the BPMS reliability umbrella. Do not treat the large P0 runtime
   issues under it as independent from the M0/M1 gates.
5. `#618` Action Spine extraction remains blocked until `#684`, `#685`, and
   `#741-#744` are complete.
6. Ordinary delivery remains Developer -> Reviewer. Optional QA agents are used
   only when the reviewer explicitly asks for specialist QA.

## Execution Roadmap

| Seq | Issue | Priority | Roadmap role | Depends on / notes |
| ---: | --- | --- | --- | --- |
| 0 | `#812` EEPC routes tasks to closed/terminal cases | P0 paused | Immediate unpause item | Paused by Yegor. When unpaused, fix before other dispatcher/workflow work. |
| 1 | `#759` Lean Konoha runtime and resource diet program | P0 | Active lean epic | Umbrella for M0 resource diet and host stability. |
| 2 | `#672` Flight-grade BPMS architecture program | P0 | BPMS umbrella | Owns constructor-to-runtime reliability; execute through M0-M6 gates. |
| 3 | `#797` Decide repo, module, and deployment boundaries | P1 | Architecture decision | Do before major package/service refactors and before public architecture docs. |
| 4 | `#766` MCP cost catalog and role allowlists | P1 | Measurement foundation | Blocks reliable decisions for lazy packs, duplicate MCP removal, and Yonote scope. |
| 5 | `#784` Default-off feature flags for experimental surfaces | P1 | Surface reduction | Enables lean profiles without deleting experimental product code. |
| 6 | `#767` Lazy/on-demand MCP tool packs | P1 | Runtime reduction | Depends on `#766`; move heavy rare tools out of eager startup. |
| 7 | `#782` Pinned local MCP installs for always-on servers | P1 | Deterministic startup | Depends on `#766`; separate always-on required MCPs from on-demand packs. |
| 8 | `#783` Remove duplicate Telethon/Bitrix MCP instances | P1 | Duplicate process reduction | Depends on `#766`; preserve Sasuke/chat and active Bitrix workflows. |
| 9 | `#764` Naruto/Sasuke separation decision and rollback plan | P1 | Chat/orchestration safety | Must precede any consolidation experiment. |
| 10 | `#765` On-demand lifecycle policy for Kakashi/Shino | P1 | Agent memory reduction | Depends on `#764`; preserve explicit GitHub review/test workflows. |
| 11 | `#758` Bounded on-demand TestBench/browser profiles | P1 | Browser resource cap | Required before browser-heavy QA or staging browser pools. |
| 12 | `#770` systemd MemoryMax/CPUQuota for optional agents/MCP/TestBench | P1 | Resource enforcement | Should land before bounded worker pool is enabled. |
| 13 | `#791` Bounded SDD dev/test worker pool | P1 | Delivery lane cap | Depends on `#765`, `#758`, and `#770`. |
| 14 | `#772` Shared Kiba monitor for prod/staging | P1 | Monitoring consolidation | Needs environment labels; staging remediation must not target prod. |
| 15 | `#773` Host-level non-Konoha service budget | P2 | Capacity model | Do before disabling host services; mail stack remains reserved. |
| 16 | `#779` Audit/disable safe non-Konoha host services | P1 | Host cleanup | Depends on `#773`; disable only with rollback commands. |
| 17 | `#769` Cache cleanup and retention policy | P1 | Disk hygiene | Include dry-run and avoid deleting active runtime dependencies. |
| 18 | `#775` Minimal Yonote read context for Sasuke | P1 | Selective context expansion | Depends on `#766`; measure memory/process delta and fallback. |
| 19 | `#661` Healthcheck routing and baseline suppression | P2 | Noise reduction | Keeps Shikadai/Naruto signal clean after monitor consolidation. |
| 20 | `#682` Isolate test storage from production Redis/PostgreSQL | P1 | M1 isolation gate | Required before workflow-engine behavior changes and staging smoke. |
| 21 | `#733` Isolated Redis namespace or DB for Bun tests | P1 | Test Redis isolation | Child of `#682`. |
| 22 | `#734` Isolated PostgreSQL schema/database for tests | P1 | Test PG isolation | Child of `#682`. |
| 23 | `#735` Test environment guardrails and fail-fast checks | P1 | Safety guardrail | Blocks accidental prod writes from tests. |
| 24 | `#736` Disposable test factories/namespaces | P1 | Test cleanup | Reduces state leakage after `#733/#734`. |
| 25 | `#753` Isolated staging environment | P1 | Staging rollout | Start only after lean baseline and test isolation gates or explicit waiver. |
| 26 | `#796` Canonical release policy and release gates | P1 | Release governance | Should use canonical labels and staging assumptions from `#753`. |
| 27 | `#749` Workflow-engine preflight tiers | P2 | Preflight structure | Feeds release checklist and golden-path suites. |
| 28 | `#750` Workflow runtime rollback/recovery runbook | P2 | Operational recovery | Should reflect `#812` terminal-case rules. |
| 29 | `#751` Constructor/runtime PR release checklist | P2 | Reviewer checklist | Depends on `#796`, `#749`, and `#750`. |
| 30 | `#756` Delivery team model and responsibilities | P2 | Process cleanup | Use evidence from `#791`, `#753`, and release gates. |
| 31 | `#674` Canonical workflow validation contract | P0 | M2 validation umbrella | Depends on M1 isolation; blocks unsafe deploy/run claims. |
| 32 | `#687` Workflow lifecycle schema and migration | P0 | Lifecycle foundation | Establish draft/deployable/deployed/retired states. |
| 33 | `#688` Gate case.start by executable workflow status | P0 | Runtime safety gate | Depends on `#687`. |
| 34 | `#689` workflow.deploy and workflow.retire action definitions | P0 | Action contract | Depends on lifecycle vocabulary. |
| 35 | `#690` Surface lifecycle state in UI/run controls | P0 | Operator visibility | Depends on `#687/#688`. |
| 36 | `#691` Versioned deployed workflow snapshots | P1 | Running-case stability | Needed before mutable workflow changes affect active cases. |
| 37 | `#692` Machine-readable validation error taxonomy | P0 | Validation taxonomy | Parent for structured validation errors. |
| 38 | `#693` Validate graph reachability and terminal states | P0 | Graph validation | Depends on `#692`. |
| 39 | `#694` Validate gateway condition syntax/dependencies | P0 | Gateway validation | Depends on `#692`. |
| 40 | `#695` Validate trigger readiness and resolver ambiguity | P0 | Trigger readiness | Depends on `#692`; informs deploy. |
| 41 | `#696` Validate adapter and document bindings | P0 | Binding readiness | Depends on `#692`. |
| 42 | `#697` Validation API and frontend diagnostics panel | P1 | UI/API diagnostics | Depends on `#692-#696`. |
| 43 | `#675` Durable assistant edits through Action Spine | P0 | M3 durable-edit umbrella | Depends on validation contract and lifecycle gates. |
| 44 | `#698` Atomic workflow patch service | P0 | Server edit foundation | Required for durable constructor mutations. |
| 45 | `#699` Assistant preview vs durable commit modes | P0 | UX/action semantics | Depends on `#698`. |
| 46 | `#700` Reconcile optimistic canvas patches with backend state | P0 | Frontend consistency | Depends on `#698/#699`. |
| 47 | `#701` Conflict detection for concurrent workflow edits | P1 | Edit safety | Depends on durable patch storage. |
| 48 | `#702` Assistant receipts for partial edit failures | P1 | Operator evidence | Depends on durable edit execution. |
| 49 | `#676` Element/flow/trigger Action Spine executors | P0 | Mutation executor umbrella | Implement after patch service contract is clear. |
| 50 | `#705` element.update direct executor | P0 | Element mutation | Child of `#676`. |
| 51 | `#706` element.remove direct executor | P0 | Element mutation | Child of `#676`. |
| 52 | `#708` trigger.set direct executor | P0 | Trigger mutation | Child of `#676`. |
| 53 | `#709` trigger.resolve deterministic review action | P1 | Trigger review | Completes trigger mutation/readiness surface. |
| 54 | `#677` Workflow deployment service | P1 | M4 deploy umbrella | Depends on lifecycle, validation, durable edits, and executors. |
| 55 | `#710` Deployment transaction model/idempotency keys | P1 | Deploy design | First child of `#677`. |
| 56 | `#711` Deploy records and subscription diff storage | P1 | Deploy persistence | Depends on `#710`. |
| 57 | `#712` Start-event subscriptions behind workflow.deploy | P1 | Deploy materialization | Depends on `#711`. |
| 58 | `#713` Undeploy/retire behavior for active subscriptions | P1 | Deploy cleanup | Depends on `#712`. |
| 59 | `#714` Deploy retry and rollback semantics | P1 | Deploy recovery | Depends on deploy records and subscription diffs. |
| 60 | `#678` Durable runtime side-effect outbox | P1 | M4 outbox umbrella | Depends on deploy transaction direction. |
| 61 | `#715` Runtime effect/outbox data model | P1 | Outbox foundation | First child of `#678`. |
| 62 | `#716` Outbox worker with retry/dead-letter policy | P1 | Effect execution | Depends on `#715`. |
| 63 | `#717` Work item dispatch through outbox | P1 | Dispatch reliability | Depends on `#716`. |
| 64 | `#718` Adapter execution through outbox where safe | P1 | Adapter reliability | Depends on `#716`. |
| 65 | `#719` Event subscription/reminder scheduling through outbox | P1 | Scheduled effects | Depends on `#716`. |
| 66 | `#720` Recovery CLI/API for pending and failed effects | P1 | Effect recovery | Depends on outbox worker behavior. |
| 67 | `#679` Role assignment and executable readiness | P1 | M4 role-readiness umbrella | Depends on validation and outbox dispatch path. |
| 68 | `#721` Role readiness checks in workflow.validate | P1 | Validation readiness | Child of `#679`. |
| 69 | `#722` Role assignment UI from validation errors | P1 | Operator assignment UI | Depends on `#721`. |
| 70 | `#723` Assistant role assignment suggestions | P1 | Assistant assist | Depends on role readiness taxonomy. |
| 71 | `#724` Dispatch receipt target details | P1 | Delivery evidence | Depends on reliable dispatch path. |
| 72 | `#680` Deterministic state-machine core/effect boundary | P1 | M5 runtime core | Depends on deploy and outbox semantics. |
| 73 | `#725` Pure graph transition planner | P1 | State-machine extraction | First child of `#680`. |
| 74 | `#726` Deduplicate gateway split/join handling | P1 | Runtime cleanup | Depends on transition planner. |
| 75 | `#727` Property-style transition regression fixtures | P1 | Runtime tests | Depends on planner surface. |
| 76 | `#728` Explicit subprocess transition/effect contract | P1 | Subprocess boundary | Depends on effect boundary. |
| 77 | `#681` Operator-grade observability/recovery/retry controls | P1 | M5 operations umbrella | Depends on outbox and state-machine evidence. |
| 78 | `#729` Case timeline events for effects/deploy receipts | P1 | Timeline evidence | Child of `#681`. |
| 79 | `#730` Failed-effect and waiting-state monitor views | P1 | Operator UI | Depends on timeline/effect state. |
| 80 | `#731` Audit-linked recovery actions | P1 | Secure recovery | Depends on recovery actions and audit trail. |
| 81 | `#732` Operational alerts for stuck cases/failed effects | P2 | Alerting | Depends on monitor views and effect state. |
| 82 | `#683` Redis/PostgreSQL consistency and PG_READ gate | P1 | Persistence gate | Depends on stable runtime semantics and observability. |
| 83 | `#737` pg-verify agent presence mismatch | P1 | PG verification fix | Child of `#683`. |
| 84 | `#738` PG-only retention classes and cleanup candidates | P1 | Retention design | Child of `#683`; informs cleanup safety. |
| 85 | `#739` PG_READ readiness dashboard/report | P1 | Cutover evidence | Depends on verification and retention classes. |
| 86 | `#740` Staged PG_READ entity flags | P2 | Controlled cutover | Depends on readiness report. |
| 87 | `#754` High-volume runtime retention/archive/UI compaction | P1 | BPMS scale guard | Depends on runtime observability and retention semantics. |
| 88 | `#685` Golden-path acceptance suite | P2 | M6 acceptance umbrella | Depends on lifecycle, validation, durable edits, deploy, outbox, and PG consistency. |
| 89 | `#745` Deterministic assistant fixture | P2 | Test fixture base | Required before golden-path tests avoid live LLMs. |
| 90 | `#746` Backend golden-path durable workflow test | P2 | Server acceptance | Depends on `#745`. |
| 91 | `#747` Browser E2E AssistantWidget/ProcessEditor path | P2 | UI acceptance | Depends on `#745`, `#758`, and preferably `#753`. |
| 92 | `#748` Negative golden-path tests | P2 | Safety acceptance | Depends on validation/deploy refusal semantics. |
| 93 | `#686` Workflow-engine release gate/runbook | P2 | Production signoff | Depends on `#685`, `#749-#751`, and staging evidence. |
| 94 | `#684` Action Spine extraction readiness | P2 | Extraction gate umbrella | Depends on `#685`; keeps extraction blocked until semantics stabilize. |
| 95 | `#741` Action Spine core port interfaces | P2 | Port boundary | Child of `#684`. |
| 96 | `#742` Split Konoha action vocabulary from core types | P2 | Package boundary | Depends on `#741`. |
| 97 | `#743` Update `#618` extraction checklist/blockers | P2 | Tracking hygiene | Depends on `#741/#742`. |
| 98 | `#744` Package extraction spike after stabilization | P2 | Extraction spike | Depends on `#741-#743` and release signoff. |
| 99 | `#618` Extract Action Spine framework | P2 | Long-term extraction | Blocked until `#684`, `#685`, and `#741-#744` are complete. |
| 100 | `#798` Public GitHub Wiki projection | P2 | Public docs | Last in this set; depends on `#797` and `#796`. |

## Parallelization Notes

- M0 lean/runtime work can split into measurement (`#766`, `#773`),
  configuration (`#784`, `#770`), and cleanup (`#767`, `#782`, `#783`,
  `#769`, `#779`), but merge through Developer -> Reviewer one issue at a
  time.
- M1 isolation work can run as small parallel implementation branches:
  Redis isolation (`#733`), PostgreSQL isolation (`#734`), guardrails (`#735`),
  and factory cleanup (`#736`). Staging `#753` should wait for the isolation
  proof or an explicit waiver.
- M2 validation can split by validator class after `#692` lands:
  graph (`#693`), gateways (`#694`), triggers (`#695`), bindings (`#696`), and
  diagnostics (`#697`).
- M3 durable edit work should keep server patching (`#698`) ahead of UI
  reconciliation (`#700`) and receipts/conflict handling (`#701/#702`).
- M4 deployment/outbox/role readiness can split into three lanes only after the
  deploy transaction model (`#710`) and outbox data model (`#715`) are accepted.
- M5 runtime correctness and operations can split into state-machine,
  observability, and PG_READ lanes, but all must join before `#685` acceptance.
- `#618` extraction and `#798` public Wiki should remain late. They publish or
  package architecture and should not outrun the accepted runtime semantics.

## Dispatch Recommendation

Next actionable issue: `#797` if the goal is architecture sequencing, or `#766`
if the goal is immediate runtime-diet measurement under `#759`.

Do not dispatch `#812` until Yegor lifts the Codex-stability pause. Do not start
the large P0 BPMS implementation set (`#674/#675/#676` and children) until M0
lean gates and M1 isolation have either landed or received an explicit waiver.
