# Konoha Backlog Roadmap — 2026-05-20

Scope: open GitHub issues in the requested `#745-#812` architecture/runtime
backlog range.

## Review Findings

- GitHub currently shows 30 open issues in the requested range, not 29:
  `#745`, `#746`, `#747`, `#748`, `#749`, `#750`, `#751`, `#753`, `#754`,
  `#756`, `#758`, `#759`, `#764`, `#765`, `#766`, `#767`, `#769`, `#770`,
  `#772`, `#773`, `#775`, `#779`, `#782`, `#783`, `#784`, `#791`, `#796`,
  `#797`, `#798`, `#812`.
- Priority is present for 29/30 issues by title and legacy label. `#791` has
  `P1` in the title but no priority label.
- Canonical priority labels are not normalized. Only `#812` has
  `priority:p0`; the rest use legacy `P0`, `P1`, `P2` labels.
- None of the 30 issues has a canonical `state:*` or `agent:*` label in the
  fetched label set, so watchdog routing is not fully aligned with
  `docs/label-taxonomy.md`.
- Existing `docs/product-roadmap.md` is a product horizon roadmap, not a full
  backlog execution sequence. This document fills that gap for the current
  architecture/runtime backlog.

## Gates

1. Do not close any issue without Shikadai reviewer acceptance.
2. `#812` is P0 but paused by Yegor until Codex stabilizes. Keep it visible as
   the first unpause item because terminal/closed cases must not route new work.
3. Treat `#759` as the active P0 epic. Its child work should reduce always-on
   agents, MCPs, browser pools, caches, and host service pressure before broad
   staging or BPMS runtime expansion.
4. Normalize labels before dispatching work:
   add exactly one `priority:p*`, exactly one `state:*`, and a matching
   `agent:*` per `docs/label-taxonomy.md`; remove legacy priority labels after
   migration.

## Execution Roadmap

| Seq | Issue | Priority | Roadmap role | Depends on / notes |
| ---: | --- | --- | --- | --- |
| 0 | `#812` EEPC routes tasks to closed/terminal cases | P0 paused | Immediate unpause item | Paused by Yegor. When unpaused, fix before other dispatcher/workflow work. Code already has a partial guard in `recoverStuckWorkItems` for `kase.status === "running"`, but issue scope also requires GitHub issue closure/case terminal synchronization. |
| 1 | `#759` Lean Konoha runtime and resource diet epic | P0 | Active umbrella | Owns lean baseline; do not close until child issues prove measurable savings and rollback paths. |
| 2 | `#797` Repo, module, deployment boundaries | P1 | Architecture decision | Do before major package/service refactors and before public architecture docs. |
| 3 | `#766` MCP cost catalog and role allowlists | P1 | Measurement foundation | Blocks reliable decisions for lazy packs, duplicate MCP removal, and Yonote scope. |
| 4 | `#784` Default-off feature flags for experiments | P1 | Surface reduction | Enables lean profiles without deleting experimental product code. |
| 5 | `#767` Lazy/on-demand MCP tool packs | P1 | Runtime reduction | Depends on `#766`; move heavy rare tools out of eager startup. |
| 6 | `#782` Pinned local MCP installs for always-on servers | P1 | Deterministic startup | Depends on `#766`; separate always-on required MCPs from on-demand packs. |
| 7 | `#783` Remove duplicate Telethon/Bitrix MCP from non-owner agents | P1 | Duplicate process reduction | Depends on `#766`; must preserve Sasuke/chat and any active Bitrix workflows. |
| 8 | `#764` Naruto/Sasuke separation decision and rollback plan | P1 | Chat/orchestration safety | Must precede any consolidation experiment. |
| 9 | `#765` On-demand lifecycle policy for Kakashi/Shino | P1 | Agent memory reduction | Depends on `#764` boundaries; preserve explicit GitHub review/test workflows. |
| 10 | `#758` Bounded on-demand TestBench/browser profiles | P1 | Browser resource cap | Required before browser-heavy QA or staging browser pools. |
| 11 | `#770` systemd MemoryMax/CPUQuota for optional agents/MCP/TestBench | P1 | Enforcement | Should land before bounded worker pool is enabled. |
| 12 | `#791` Bounded SDD dev/test worker pool | P1 label missing | Delivery lane cap | Parents include `#765`, `#758`, `#770`; add canonical priority/state/agent labels before dispatch. |
| 13 | `#772` Single shared Kiba monitor for prod/staging | P1 | Monitoring consolidation | Needs environment labels; must not let staging remediation touch prod. |
| 14 | `#773` Host-level non-Konoha service budget | P2 | Capacity model | Do before disabling host services; mail stack remains reserved. |
| 15 | `#779` Audit/disable safe non-Konoha host services | P1 | Host cleanup | Depends on `#773`; only disable with rollback commands. |
| 16 | `#769` Cache cleanup and retention policy | P1 | Disk hygiene | Can run after main MCP/browser direction is known; must include dry-run. |
| 17 | `#775` Minimal Yonote read context for Sasuke | P1 | Selective context expansion | Depends on `#766`; do not broaden Sasuke MCP profile without measured delta and fallback. |
| 18 | `#753` Isolated staging environment | P1 | Safe runtime/test expansion | Start only after lean baseline gates for MCP/agents/TestBench are in place or explicitly waived. |
| 19 | `#796` Canonical release policy and gates | P1 | Release governance | Should use canonical label taxonomy and staging assumptions from `#753`; informs `#751` and public docs. |
| 20 | `#754` Runtime retention, archival, UI compaction | P1 | BPMS scale guard | Place after staging/release direction; required before high-volume messenger/process tests. |
| 21 | `#749` Workflow-engine preflight tiers | P2 | Test gate structure | Depends on release policy direction; feeds PR checklist and golden-path suites. |
| 22 | `#750` Runtime rollback and recovery runbook | P2 | Operational recovery | Depends on preflight tier split; should reflect `#812` terminal-case rules. |
| 23 | `#751` Constructor/runtime PR release checklist | P2 | Reviewer/developer checklist | Depends on `#796`, `#749`, `#750`. |
| 24 | `#745` Deterministic assistant fixture | P2 | Test fixture base | Required before backend/browser golden-path automation avoids live LLM. |
| 25 | `#746` Backend golden-path durable workflow test | P2 | Server acceptance | Depends on `#745`; proves create/validate/deploy/start/work-item path. |
| 26 | `#747` Browser E2E through AssistantWidget/ProcessEditor | P2 | UI acceptance | Depends on `#745`, `#758`, and preferably `#753`. |
| 27 | `#748` Negative golden-path tests | P2 | Safety acceptance | Depends on validation/deploy semantics; should include non-executable workflow refusals. |
| 28 | `#756` Delivery team model and responsibilities | P2 | Process cleanup | Use evidence from `#791`, `#753`, and release gates; update AGENTS/runbooks only after decision. |
| 29 | `#798` Public GitHub Wiki projection | P2 | Public docs | Last in this set; depends on `#797` architecture boundaries and `#796` release/docs policy. |

## Parallelization Notes

- `#797`, `#766`, and `#784` can be prepared in parallel because they write
  different decision surfaces, but implementation should still merge one issue
  at a time through Developer -> Reviewer.
- `#773` can run early as a read-only capacity model, but `#779` should wait
  for that model before disabling services.
- `#745` can be drafted once test contracts are stable, but `#746-#748` should
  wait until staging/resource gates are not fighting the test environment.

## Dispatch Recommendation

After label normalization, the next actionable implementation issue should be
`#797` if the goal is architectural sequencing, or `#766` if the goal is
immediate runtime diet measurement under `#759`. Do not dispatch `#812` until
Yegor lifts the Codex-stability pause.
