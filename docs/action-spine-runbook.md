# Action Spine Runbook

Date: 2026-04-29

Action Spine is Konoha's control plane for user-visible operations. GUI, HTTP,
MCP tools, agents, and the testbench should describe the same operation with one
canonical action ID from `src/action-registry.ts`; `/act` validates the envelope,
checks actor policy, applies autonomy/audit rules, and routes to the current
handler or compatibility endpoint.

The registry is the source of truth. The generated machine-readable surface is
`docs/action-surface.json`; regenerate or check it with
`bun run scripts/action-surface-report.ts --write|--check`.
Workflow construction/runtime security, authorization, and audit semantics are
defined in `docs/workflow-security-boundary.md`.

## Current Surface

`docs/action-surface.json` is the canonical matrix for:

| Column | Source |
|---|---|
| action ID | `actions[].id` |
| category | `actions[].category` (`act`, `inspect`, `drill`) |
| endpoint/service | `actions[].current_endpoint` and `actions[].implementation` |
| RBAC | `actions[].security` |
| audit | `actions[].audited` |
| GUI/MCP/testbench availability | derived from consumers of the same action ID |

Use the JSON when building UI affordances, MCP coverage reports, or testbench
harnesses. Do not hand-maintain a second full action matrix in Markdown.

Current consumer status:

| Consumer | Status | Source of truth |
|---|---|---|
| API | `/act` exposes implemented registry actions and compatibility endpoints | `/act`, `src/act-envelope.ts` |
| MCP | Generic `konoha_action_*` tools cover implemented actions | `src/mcp-action-bridge.ts` |
| GUI | Migration is incremental; new mutations should call `/act` | `docs/action-surface.json`, issue `#602` |
| Testbench | Harness should consume the same action surface when migrated | `docs/action-surface.json`, issue `#603` |

## Assistant Invocation Testbench

`assistant.invoke` is the canonical non-streaming Action Spine entry point for
testing product assistants such as Tsunade. It is intentionally deterministic by
default for regression scenarios: tests may pass `fixture_response` and
`persist_history: false` to exercise server-side response normalization, action
receipts, and policy behavior without depending on a live LLM provider.

Minimal deterministic envelope:

```json
{
  "action": "assistant.invoke",
  "category": "act",
  "args": {
    "assistant_id": "tsunade",
    "message": "Create a workflow",
    "persist_history": false,
    "execute_actions": false,
    "fixture_response": "{\"reply\":\"Prepared workflow\"}"
  }
}
```

Use `/api/ai/chat` for streaming UI chat until the UI is migrated. Use
`assistant.invoke` for HTTP/MCP/testbench assertions where the caller needs a
stable response containing `reply`, `normalized_response`, `actions_taken`,
`action_results`, `pending_confirmations`, `conversation_id`, and `trace_id`.

## When To Use `/act`

Use `/act` for any user-visible operation that changes system state or should be
visible to agents as a durable capability. This includes workflow edits, case and
work item lifecycle operations, access changes, reminders, agent lifecycle, bus
messages, and any operation that needs a shared action ID, actor policy, audit
entry, autonomy check, or MCP/testbench parity.

Direct REST is acceptable for compatibility wrappers, streaming or long-lived
transport surfaces, static assets, health/setup/admin plumbing that is not an
agent capability, and narrow read endpoints that are not part of the Action Spine
contract yet. New product or agent-facing mutations should not add bespoke REST
semantics first; add or extend an action and route the caller through `/act`.

Existing REST endpoints may remain while migration is in progress, but they
should delegate to the same domain service or executor path as the canonical
action instead of duplicating behavior.

## Add A New Action

1. Add one dotted `{scope}.{verb}` entry to `ACTIONS` in `src/action-registry.ts`.
2. Define the argument contract, implementation metadata, `currentEndpoint` when
   routing through an existing endpoint, autonomy, and `audited`.
3. Confirm the category produced by `classifyAction()` is correct. Workflow edit
   and lifecycle verbs such as `add`, `set`, `resolve`, `deploy`, `retire`, and
   `validate` must be `act`; extend `src/action-policy.ts` when a new mutation
   verb or actor boundary needs a rule.
4. Set or verify the actor policy from `getActionSecurity()`. Admin-only
   mutations should stay admin-only unless a narrower `agent_self` or
   authenticated read policy is intentional.
5. Wire execution through a direct executor, registered handler, or endpoint
   resolver. Planned actions may exist in the vocabulary, but callers must treat
   `implemented: false` as not executable.
6. If MCP callers need the operation, prefer the generic tools:
   `konoha_action_catalog`, `konoha_action_get`, and `konoha_action_call`.
   Add a bespoke MCP tool only for a stable high-value workflow.
7. Regenerate `docs/action-surface.json` if the registry changed, and commit it
   with the code change.
8. Run at least:
   `bun run scripts/action-surface-report.ts --check` and `bun x tsc --noEmit`.

## MCP And Agents

The generic MCP bridge in `src/mcp-action-bridge.ts` exposes the Action Spine as:

- `konoha_action_catalog` for discovering implemented actions, optionally by
  scope or category.
- `konoha_action_get` for one action's args, security, audit, and implementation
  metadata.
- `konoha_action_call` for invoking `/act` and receiving the same action receipt
  as HTTP callers.

Agents should call `konoha_register` before `konoha_action_call` so the MCP
bridge has an explicit agent token. Tool responses must not log or echo tokens or
other secrets.
