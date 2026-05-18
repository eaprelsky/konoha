# Action Registry — Unified Vocabulary (#499)

> Source: `src/action-registry.ts`

## Overview

Every operation the system exposes — API, MCP, assistant, UI — is described as a **single, versioned action** in the registry. This gives us:

- **One source of truth** for what the system can do
- **Typed argument contracts** for each action
- **Autonomy levels** (auto / confirm / disabled) mapped per action
- **Audit trail** — every write action is logged
- **Progressive migration** — each action maps to its current HTTP endpoint

## Version

Current: **v14** (`ACTION_VERSION = 14`)

Bump the version when the vocabulary changes (new actions, renamed args, removed actions).

The short architecture/runbook for the Action Spine control plane is
`docs/action-spine-runbook.md`. The generated machine-readable action matrix is
`docs/action-surface.json`.

## Naming convention

Actions use **object-scope naming**: `{scope}.{verb}`

Category classification is derived from the verb contract, not from UI routes.
Mutation verbs include direct writes such as `add`, `set`, `resolve`, `deploy`,
`retire`, and `validate`, and the classifier also recognizes snake_case verbs
such as `batch_delete` and `update_labels` by their write segment.

| Scope | Meaning |
|-------|---------|
| `workflow` | Process definitions |
| `element` | Nodes inside a workflow |
| `flow` | Edges between elements |
| `trigger` | Event subscription configuration |
| `case` | Running process instances |
| `workitem` | Dispatched work items |
| `role` | Role definitions |
| `agent` | Agent lifecycle |
| `skill` | Skill CRUD |
| `person` | People directory |
| `access` | Trusted users and Telegram group access |
| `adapter` | Data adapter operations |
| `subscription` | Event manager subscriptions |
| `issue` | GitHub issues |
| `reminder` | Scheduled reminders |
| `message` | Bus messages |
| `audit` | Audit log reads |
| `knowledge` | Knowledge base files |

## Action catalog

This section is a human overview. Use `docs/action-surface.json` for the exact
current list, including category, implementation, security, audit, endpoint, and
argument metadata.

### Workflow (`workflow.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `workflow.create` | Create new workflow as draft or validated; never deploys runtime triggers | confirm |
| `workflow.update` | Update existing workflow as draft or validated; demotes executable workflows until redeploy | confirm |
| `workflow.deploy` | Validate, materialize runtime start triggers, and mark workflow executable | confirm |
| `workflow.delete` | Archive workflow + cascade delete cases | confirm |
| `workflow.list` | List all workflows | auto |
| `workflow.get` | Get single workflow by ID | auto |

### Element (`element.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `element.add` | Add a validated event/function/gateway element to a workflow through the direct Action Spine executor | confirm |
| `element.update` | Update element properties | confirm |
| `element.remove` | Remove element + connected edges | confirm |

### Flow (`flow.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `flow.add` | Add a validated edge between existing workflow elements through the direct Action Spine executor | confirm |
| `flow.remove` | Remove a validated edge through the direct Action Spine executor | confirm |

### Trigger (`trigger.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `trigger.set` | Set trigger config on event element | confirm |
| `trigger.resolve` | Auto-detect trigger kind via resolver | auto |

### Case (`case.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `case.start` | Start new case from workflow | auto |
| `case.get` | Get case by ID | auto |
| `case.list` | List cases with filters | auto |
| `case.close` | Force-close running case | confirm |
| `case.cancel` | Cancel a stuck case and release runtime waits, subscriptions, and active work items | confirm |
| `case.delete` | Delete a case and its related runtime work items | confirm |

### Work Item (`workitem.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `workitem.create` | Create standalone work item | auto |
| `workitem.complete` | Complete work item with output | auto |
| `workitem.update` | Update status/assignee/deadline | auto |
| `workitem.list` | List work items with filters | auto |
| `workitem.cancel` | Cancel a work item | auto |

### Role (`role.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `role.create` | Create role definition | confirm |
| `role.list` | List all roles | auto |
| `role.update` | Update role | confirm |
| `role.delete` | Delete role | confirm |

### Agent (`agent.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `agent.register` | Register agent on bus | auto |
| `agent.start` | Start stopped agent | confirm |
| `agent.stop` | Stop running agent | confirm |
| `agent.restart` | Restart agent | confirm |

### Subscription (`subscription.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `subscription.create` | Create event subscription | auto |
| `subscription.cancel` | Cancel subscription | auto |
| `subscription.list` | List active subscriptions | auto |

### Issue (`issue.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `issue.create` | Create GitHub issue | auto |

### Reminder (`reminder.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `reminder.create` | Create scheduled reminder | auto |
| `reminder.list` | List reminders | auto |
| `reminder.update_status` | Update reminder status | auto |
| `reminder.delete` | Delete reminder | auto |

### Message (`message.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `message.send` | Send message to agent/role/broadcast | auto |
| `message.read` | Read new messages | auto |

### Audit (`audit.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `audit.read` | Read action audit log | auto |

### Knowledge (`knowledge.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `knowledge.tree` | Get KB file tree | auto |
| `knowledge.read` | Read KB file | auto |
| `knowledge.search` | Search KB | auto |

## Argument contracts

Each action defines its arguments with:

```typescript
interface ArgumentDef {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "date";
  required: boolean;
  description: string;
}
```

## Migration path

Each action has an optional `currentEndpoint` field that maps to the existing HTTP handler. This allows progressive migration:

1. **Current**: `/act` validates the envelope against the registry, enforces actor policy/autonomy/audit rules, and routes to a direct executor, registered handler, or compatibility endpoint.
2. **Compatibility**: Existing REST endpoints may remain, but new user-visible mutations should share the action contract instead of adding separate behavior.
3. **Future**: Old wrappers can be retired once GUI, MCP, agents, and tests use the action ID directly.

## Usage in code

```typescript
import { getAction, listActions, isValidAction } from "./action-registry";

// Check if an action exists
if (!isValidAction("workflow.create")) throw new Error("Unknown action");

// Get action definition
const action = getAction("case.start");
console.log(action.args);       // argument contract
console.log(action.autonomy);   // "auto" | "confirm" | "disabled"

// List all actions in a scope
const workActions = listActions("workitem");
```

## Canonical operator spine

The registry vocabulary is not documentation-only anymore; it is the naming contract shared across:

- `act-envelope` requests via `ActEnvelope.action`
- autonomy matrix keys in `assistant-actions.ts`
- audit log `action_type` values
- assistant-side `actions_taken[].action`
- direct server-side handlers registered in `src/action-handlers.ts`

Canonical IDs use dotted registry names such as `workflow.create` and `issue.create`.
Legacy snake_case aliases may still be accepted during migration, but new code must emit and persist the dotted IDs.

At least one assistant flow already uses this spine as its primary mutation path:

- `normalizeAssistantResponse()` executes `workflow.create` through `executeAction()`
- `executeAction()` resolves the registered direct handler from `src/action-handlers.ts`
- the resulting `actions_taken[]` and audit entries keep the same canonical action ID end-to-end

## Adding new actions

Use `docs/action-spine-runbook.md` as the contribution checklist. In short:

1. Add an entry to the `ACTIONS` array in `src/action-registry.ts`
2. Follow the `{scope}.{verb}` naming convention
3. Set appropriate autonomy, security, implementation metadata, and audit flags
4. Bump `ACTION_VERSION` when the vocabulary changes
5. Regenerate/check `docs/action-surface.json`
