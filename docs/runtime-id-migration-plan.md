# Runtime ID compatibility migration

This is the compatibility-safe plan for #620. Do not rename systemd units, tmux sessions, Redis keys, memory paths, or watchdog files in this slice.

## Boundary

Runtime IDs such as `naruto`, `sasuke`, and `kakashi` are technical identifiers. Product surfaces should use workflow roles, connector names, canonical agent names, or tenant-local display aliases.

The machine-readable map is `docs/runtime-id-compatibility-map.json`.

Required fields:

- `runtime_id`: stable technical ID.
- `product_role_key`: portable product/business role key.
- `canonical_name`: product-facing actor name.
- `display_alias`: mutable local callsign.
- `service_name`: current systemd unit or template instance.
- `tmux_session`: current session/socket ID.
- `connector_role`: core, connector-owned, optional worker, deprecated compatibility, or external operator.

## Inventory

| Surface | Runtime ID usage | Classification |
| --- | --- | --- |
| `systemd/agent-*.service`, watchdog units | Service names, env vars, `ExecStart` args | Allowed internal |
| tmux sessions and watchdog scripts | Runtime process targeting | Allowed internal |
| Redis bus, streams, heartbeats, work item assignees | Stable routing keys | Allowed internal |
| `agents/*/AGENTS.md`, memory directories | Agent-local runtime identity | Allowed internal |
| MCP/bus addressing | Technical routing IDs | Allowed internal; docs should prefer portable examples |
| Operator/debug UI (`Agents`, tmux modal, lifecycle controls) | Runtime diagnostics | Allowed internal when explicitly labeled/debug |
| Product workflow definitions and role IDs | Business semantics | Product leak if runtime IDs appear |
| Customer guides, demo copy, process templates | Product language | Product leak unless documenting compatibility |
| General product UI labels | Actor labels | Product leak if `id` is the primary label |

## Follow-up slices

1. Replace hardcoded default recipients in `frontend/src/pages/Messages.tsx` with agents returned by the API plus display labels.
2. Rename legacy assistant API aliases (`api.tsunade`, `api.jiraiya`) behind canonical `api.assistant`/KB assistant calls while keeping compatibility wrappers.
3. Move CSS class names based on legacy aliases behind neutral component names when touching those panels.
4. Add runtime ID -> service/session lookup in lifecycle code so future service renames only change the compatibility map.
5. Add migration scripts for systemd/tmux names only after dashboards and prompts no longer depend on runtime IDs.

## Rollback Rules

Every migration slice must preserve a compatibility path:

- UI/copy changes roll back by reverting the single UI or docs commit; runtime ids are unchanged.
- API alias changes must keep compatibility wrappers until access logs show no production callers.
- CSS/component renames must keep old test selectors or data attributes for one release.
- Service/session lookup changes must read from `docs/runtime-id-compatibility-map.json`; rollback is restoring the previous map entry.
- Actual systemd/tmux renames require a two-step rollout: add alias lookup first, then rename one non-critical optional worker, then only proceed if healthcheck stays green.

## Guard

`scripts/check-runtime-id-product-leaks.ts` scans selected product-surface files for known runtime IDs. Existing compatibility examples are allowlisted with reasons; new occurrences fail until they are either removed or classified.

```bash
bun run scripts/check-runtime-id-product-leaks.ts
```
