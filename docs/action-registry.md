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

Current: **v1** (`ACTION_VERSION = 1`)

Bump the version when the vocabulary changes (new actions, renamed args, removed actions).

## Naming convention

Actions use **object-scope naming**: `{scope}.{verb}`

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
| `subscription` | Event manager subscriptions |
| `issue` | GitHub issues |
| `reminder` | Scheduled reminders |
| `message` | Bus messages |
| `audit` | Audit log reads |
| `knowledge` | Knowledge base files |

## Action catalog

### Workflow (`workflow.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `workflow.create` | Create new workflow (draft or deployed) | confirm |
| `workflow.update` | Update existing workflow | confirm |
| `workflow.delete` | Archive workflow + cascade delete cases | confirm |
| `workflow.list` | List all workflows | auto |
| `workflow.get` | Get single workflow by ID | auto |

### Element (`element.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `element.add` | Add element to workflow | confirm |
| `element.update` | Update element properties | confirm |
| `element.remove` | Remove element + connected edges | confirm |

### Flow (`flow.*`)

| Action | Description | Autonomy |
|--------|-------------|----------|
| `flow.add` | Add edge between elements | confirm |
| `flow.remove` | Remove edge | confirm |

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

1. **Phase 1** (current): Registry is documentation + types. Existing endpoints unchanged.
2. **Phase 2**: Unified `/act` envelope (see #500) routes through the registry.
3. **Phase 3**: Old endpoints deprecated, everything goes through action IDs.

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

## Adding new actions

1. Add an entry to the `ACTIONS` array in `src/action-registry.ts`
2. Follow the `{scope}.{verb}` naming convention
3. Set appropriate autonomy level
4. Set `audited: true` for any write operation
5. Update this documentation
6. Bump `ACTION_VERSION`
