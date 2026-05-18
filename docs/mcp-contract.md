# MCP Contract

Date: 2026-05-18

Every MCP tool → action ID → parameter mapping. The Konoha MCP server bridges Claude Code's tool-calling interface to the Konoha bus API.

## Core Tools (konoha_*)

The generic Action Spine tools expose all implemented registry actions without
adding one bespoke MCP tool per operation:

| MCP Tool | Action | Parameters |
|----------|--------|------------|
| `konoha_action_catalog` | — (inspect registry) | `scope?`, `category?`, `include_planned?` |
| `konoha_action_get` | — (inspect registry) | `action` |
| `konoha_action_call` | Any implemented registry action | `action`, `category?`, `args?`, `meta?` |

Legacy/core bus tools remain available for operational workflows:

| MCP Tool | Action | Parameters |
|----------|--------|------------|
| `konoha_register` | `agent.register` | `id`, `name`, `capabilities?`, `roles?`, `model?`, `eventSubscriptions?`, `village_id?` |
| `konoha_send` | `message.send` | `from`, `to`, `text`, `type?`, `channel?`, `replyTo?`, `village_id?` |
| `konoha_read` | `message.read` | `agentId`, `count?` |
| `konoha_agents` | — (inspect) | `onlineOnly?` — lists registered agents |
| `konoha_channels` | — (inspect) | none — lists active channels |
| `konoha_heartbeat` | `agent.register` (heartbeat) | `agentId` — updates last-heartbeat timestamp |
| `konoha_history` | `message.read` (history) | `target`, `count?` — reads message history non-destructively |
| `konoha_listen` | `message.read` (listen) | `agentId`, `seconds?` — SSE listen for new messages |
| `konoha_complete_task` | `workitem.complete` | `work_item_id`, `output?` — completes a dispatched work item |

## Bespoke Tool Coverage Gaps

The generic `konoha_action_*` bridge can discover and invoke implemented
registry actions. The table below tracks gaps only for older bespoke MCP tools
that wrap one workflow directly:

| Scope | Actions without MCP | Gap |
|-------|---------------------|-----|
| workflow | workflow.create, workflow.update, workflow.delete, workflow.list, workflow.get | No workflow CRUD via MCP |
| element | element.update, element.remove | `element.add` is available through the generic `konoha_action_*` bridge; no bespoke element editing MCP tools |
| flow | — | `flow.add` and `flow.remove` are available through the generic `konoha_action_*` bridge; no bespoke flow editing MCP tools |
| trigger | trigger.set, trigger.resolve | No trigger config via MCP |
| case | — | `case.start/get/list/close/cancel/delete` are available through the generic `konoha_action_*` bridge; bespoke case MCP tools remain partial wrappers |
| workitem | workitem.create, workitem.update, workitem.list, workitem.cancel | Partial (only `workitem.complete` via `konoha_complete_task`) |
| role | role.create, role.list, role.update, role.delete | No role management via MCP |
| agent | agent.start, agent.stop, agent.restart | Only `agent.register` via MCP |
| subscription | subscription.create, subscription.cancel, subscription.list | No subscription management via MCP |
| reminder | reminder.create, reminder.list, reminder.update_status, reminder.delete | No reminder management via MCP |
| audit | audit.read | No audit reading via MCP |
| knowledge | knowledge.tree, knowledge.read, knowledge.search | No knowledge base access via MCP |

## Adding MCP Tool Coverage

To add an MCP tool for an action:

1. Add `server.tool(...)` in `src/mcp.ts` following the existing patterns.
2. Map tool parameters to action arguments using the registry's argument contract.
3. Call the Konoha HTTP API at the corresponding endpoint, or use `/act` for universal routing.
4. Update this document to reflect the new coverage.
