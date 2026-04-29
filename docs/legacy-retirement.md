# Legacy Retirement Inventory

Date: 2026-04-29

This document bounds compatibility surfaces that remain after the workflow foundation hardening work. New code must target canonical APIs/actions unless a compatibility decision below explicitly says otherwise.

## Canonical Targets

| Domain | Canonical target | Notes |
|---|---|---|
| Workflow assistant chat | `POST /api/ai/chat` with `mode: "process"` | Non-streaming and streaming responses use the canonical assistant envelope. |
| Workflow mutations | `/act` with typed `workflow.*`, `element.*`, `flow.*`, `trigger.*` actions | Legacy HTTP routes should be wrappers, not separate executors. |
| Frontend workflow chat client | `api.assistant.chat()` | `api.tsunade.*` methods are compatibility shims only. |
| Workflow entity contracts | `docs/entity-contracts.md` | Owners and storage boundaries are explicit there. |

## Active Compatibility Surfaces

| Surface | Decision | Sunset | Guardrail |
|---|---|---|---|
| `POST /api/tsunade/chat` | **REMOVED** (#594) | — | Returns 404. |
| `DELETE /api/tsunade/chat/:chat_id` | **REMOVED** (#594) | — | Returns 404. |
| `POST /api/ai/process-chat` | **REMOVED** (#594) | — | Returns 404. |
| `DELETE /api/ai/process-chat/:chat_id` | **REMOVED** (#594) | — | Returns 404. |
| `frontend/src/api/client.ts` `api.tsunade.*` | Keep as frontend compatibility aliases | 2026-05-31 | Must delegate to `api.assistant.chat()` / canonical delete paths; no direct new legacy HTTP calls. |
| `frontend/src/pages/TsunadeChatPanel.tsx` | Keep as ProcessEditor UI compatibility component | Revisit after editor UX consolidation | Must use `api.assistant.chat()` and canonical envelope fields. |
| `modules/workflow-engine` frontend wrappers | Keep | Indefinite plugin boundary | Must re-export core frontend behavior, not fork it. |
| `/workflows` create/update/list routes | Keep as compatibility HTTP routes | Revisit after MCP/action migration | Must execute through the action executor for mutations. |

## Retired Or Reference-Only Surfaces

| Surface | Decision | Guardrail |
|---|---|---|
| Direct new UI calls to `/api/ai/process-chat` | Retired | Grep should stay clean outside compatibility docs/tests. |
| Direct new UI calls to `/api/tsunade/chat` | Retired | Use `api.assistant.chat()` instead. |
| `scripts/watchdog.py` universal watchdog | Reference-only fallback | Active systemd units must not point at it. |
| Legacy per-agent systemd scripts | Retired for managed agents | Konoha lifecycle owns start/stop/restart. |

## Removal Criteria

**Completed 2026-04-29 (#594).** All four legacy routes have been removed. The unified `POST /api/ai/chat` with `mode: "process"` is the only process-chat endpoint. Legacy route tests now verify 404 responses.

## Enforcement

- `scripts/preflight-portable.sh` and `scripts/preflight.sh` include `tests/ai-chat-contract.test.ts` in their gate suites.
- Any reintroduction of `POST /tsunade/chat`, `POST /ai/process-chat`, or their DELETE counterparts will cause a typecheck or test failure.
- Grep for `/tsunade/chat` and `/ai/process-chat` must return zero non-doc, non-test hits.

## Tests

`tests/ai-chat-contract.test.ts` enforces that both legacy POST and DELETE routes return 404. Both preflight scripts include this contract test.
