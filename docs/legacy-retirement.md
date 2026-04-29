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
| `POST /api/tsunade/chat` | Keep for external/old callers only | 2026-05-31 | Must return `Deprecation`, `Sunset`, and canonical `Link` headers. |
| `DELETE /api/tsunade/chat/:chat_id` | Keep for external/old callers only | 2026-05-31 | Same deprecation headers as POST. |
| `POST /api/ai/process-chat` | Keep for external/old callers only | 2026-05-31 | Must call the same backend handler and expose canonical replacement headers. |
| `DELETE /api/ai/process-chat/:chat_id` | Keep for external/old callers only | 2026-05-31 | Same deprecation headers as POST. |
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

On or after 2026-05-31:

1. Check access logs for `/api/tsunade/chat` and `/api/ai/process-chat`.
2. Grep the repository and deployed workdirs for callers outside compatibility tests/docs.
3. If no external callers remain, remove the backend routes and frontend `api.tsunade.*` shims in one commit.
4. Keep `/api/ai/chat` contract tests as the canonical assistant regression gate.

## Tests

`tests/ai-chat-contract.test.ts` enforces that both legacy POST and DELETE routes advertise the canonical replacement. `scripts/preflight.sh` includes this contract test.
