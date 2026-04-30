# External Bus-Client / Operator Mode Design

> Issue: #623 | Priority: P2 | Date: 2026-05-01 | Author: Kakashi
> References: ADR-004, `docs/ports.md`, `docs/konoha-bus.md`

## 1. Motivation

Itachi, Shikamaru, and Shikadai emerged as historical ways to connect an external operator (human or local AI tool) to the Konoha bus. Per ADR-004, these should be user/operator connection scenarios — not seeded system agents. This document defines the external operator mode: identity, authentication, scopes, assignment semantics, and runbook.

## 2. Concept model

```
┌─────────────────────────────────────────────────────┐
│ Konoha bus (HTTP API :3200)                         │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ System   │  │ Runtime  │  │ External         │  │
│  │ agents   │  │ workers  │  │ operators        │  │
│  │ (tsunade,│  │ (Kakashi,│  │ (human via SSH,  │  │
│  │  kiba)   │  │  Guy,    │  │  local Codex,    │  │
│  │          │  │  Shino)  │  │  Claude CLI)     │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│                                                     │
│  External operators:                                │
│  - Authenticate with scoped token                  │
│  - No auto-registration, no heartbeat, no watchdog │
│  - Pull assigned work, push results               │
│  - Audited separately from managed workers         │
└─────────────────────────────────────────────────────┘
```

An external operator is a **transient client** — not a durable agent. It connects, inspects assigned work, sends messages/actions, and disconnects. There is no guaranteed availability.

## 3. Identity and authentication

### 3.1 Operator identity

```typescript
interface ExternalOperator {
  id: string;            // "alice-laptop", "ci-github-actions", "codex-demo"
  display_name: string;  // "Alice's laptop Codex"
  kind: "human" | "local-ai" | "ci" | "webhook";
  scopes: OperatorScope[];
  created_by: string;    // admin who issued the token
  created_at: string;
  expires_at?: string;   // optional expiry
}
```

### 3.2 Token scopes

```typescript
type OperatorScope =
  | "work:read"          // list assigned work items and waits
  | "work:complete"      // complete assigned work items
  | "bus:read"           // read own messages
  | "bus:send"           // send messages to agents/roles
  | "action:invoke"      // invoke registered actions
  | "inspect:agents"     // list agents and their status
  | "inspect:workflows"  // list workflows and roles
  ;
```

Default operator scope: `["work:read", "bus:read", "bus:send"]`.

### 3.3 Token management

```http
POST /api/admin/operators
  body: { display_name, kind, scopes, ttl_days? }
  returns: { id, token }

GET /api/admin/operators
  returns: [{ id, display_name, kind, scopes, created_at, last_seen }]

DELETE /api/admin/operators/:id
  revokes token immediately
```

Tokens are stored in `konoha_tokens` table with `agent_type = 'operator'` to distinguish from managed agent tokens.

### 3.4 Authentication flow

External operators authenticate by setting the `Authorization: Bearer <operator-token>` header on Konoha bus HTTP requests. The token is validated against the `konoha_tokens` table. Operator tokens are distinct from admin tokens (`KONOHA_TOKEN`) and agent tokens (`KONOHA_AGENT_TOKEN`).

## 4. Work assignment semantics

### 4.1 Human-in-the-loop vs runtime worker

| Dimension | Runtime worker | External operator |
|---|---|---|
| Availability | Watchdog-monitored, expected online | Not guaranteed |
| Assignment | Auto-dispatched by workflow engine | Pull-based from work queue |
| SLA | Contract-driven (executor-contract.ts) | Best-effort, human-paced |
| Audit | Per-agent execution log | Separate operator audit trail |
| Token | Long-lived agent token | Scoped, optionally expiring |
| Registration | `konoha_register` → permanent agent | Admin-issued, no registration step |

### 4.2 Role assignment

A workflow role can optionally target an external operator:

```json
{
  "role_id": "code_reviewer",
  "assignment": {
    "kind": "external",
    "operator_id": "alice-laptop",
    "strategy": "claim"  // operator must claim the work item
  }
}
```

Assignment strategies:
- `claim` — operator explicitly claims work items from the queue
- `notify` — work item created, operator notified via bus message
- `timeout` — if unclaimed within N minutes, reassign to fallback

### 4.3 Work item lifecycle for external operators

```
work item created (assigned to external operator)
  → bus message sent to operator
  → operator connects, inspects queue
  → operator claims work item
  → operator sends result / completes work item
  → workflow advances

If timeout:
  → work item reassigned to fallback worker or role
```

## 5. Limitations

External operators intentionally do not have:
- **Heartbeat / watchdog** — no liveness monitoring; disconnection is normal
- **Tmux session management** — no server-side session; operator manages its own runtime
- **Guaranteed message delivery** — messages are queued while operator is offline, delivered on next connect
- **Auto-registration** — admin must explicitly create operator identity and issue token
- **Agent-to-agent routing** — `from` field in bus messages uses the operator id, not a registered agent address
- **Workflow trigger subscriptions** — operators poll for work; they do not receive push events

## 6. Bus-client reference implementation

### 6.1 CLI bus client

```bash
# Authenticate
export KONOHA_BUS_URL="http://127.0.0.1:3200"
export KONOHA_OPERATOR_TOKEN="op_..."

# List assigned work
konoha-bus work list

# Claim a work item
konoha-bus work claim <work_item_id>

# Complete a work item
konoha-bus work complete <work_item_id> --result '{"status":"ok"}'

# Send a message
konoha-bus send --to role:developer --text "Review complete, LGTM"

# Read messages
konoha-bus inbox
```

### 6.2 Programmatic client (TypeScript)

```typescript
import { OperatorClient } from "@konoha/operator-client";

const client = new OperatorClient({
  busUrl: "http://127.0.0.1:3200",
  token: process.env.KONOHA_OPERATOR_TOKEN,
});

const workItems = await client.workItems.list({ status: "pending" });
await client.workItems.claim(workItems[0].id);
await client.workItems.complete(workItems[0].id, { status: "done" });
await client.send({ to: "role:developer", text: "Done" });
```

## 7. Onboarding runbook

### 7.1 Admin setup

1. Generate operator token: `POST /api/admin/operators` with scopes
2. Share token with operator (out of band: 1Password, Slack, etc.)
3. Configure workflow role to allow external assignment

### 7.2 Operator setup (SSH / local)

```bash
# 1. Install bus client (or use curl directly)
npm install -g @konoha/bus-client

# 2. Configure
konoha-bus config set url http://127.0.0.1:3200
konoha-bus config set token "op_..."

# 3. Verify connectivity
konoha-bus whoami
# → { "id": "alice-laptop", "kind": "human", "scopes": ["work:read", "bus:read", "bus:send"] }

# 4. Check assigned work
konoha-bus work list
```

### 7.3 Local Codex / Claude CLI operator

```bash
# Set environment variables for the AI tool
export KONOHA_BUS_URL="http://127.0.0.1:3200"
export KONOHA_OPERATOR_TOKEN="op_..."

# The AI tool uses the bus client to:
# - Poll for assigned work items
# - Execute tasks
# - Report results back via bus
```

## 8. Audit separation

External operator actions are audited with `audit_source: "operator"` and the operator id, distinct from:
- `audit_source: "agent"` — managed runtime workers
- `audit_source: "admin"` — admin token actions
- `audit_source: "system"` — internal system actions

This allows operators to be audited independently.

## 9. Migration: Itachi, Shikamaru, Shikadai

| Current | Target |
|---|---|
| Itachi — seeded system agent in admin routes | Remove from seeded agents. Issue operator token per user. |
| Shikamaru — seeded system agent in admin routes | Remove from seeded agents. Issue operator token per user. |
| Shikadai — architecture worker with tmux session | Optional runtime worker, or external operator if used interactively. |

Existing token references in `src/routes/admin.ts` (lines 355-371) for Shikadai should move to operator identity when the operator mode is implemented.

## 10. Acceptance criteria mapping

| AC | Status |
|---|---|
| No Itachi/Shikamaru/Shikadai seeded system agent required | ✓ — design defines them as external operators |
| External clients audited separately from managed workers | ✓ — `audit_source: "operator"` |
| Workflow role can assign work to external operator | ✓ — `assignment.kind: "external"` with claim/notify/timeout strategies |

## 11. Implementation estimate

| Deliverable | Effort |
|---|---|
| Operator identity model + token storage | 1-2h |
| Token CRUD admin endpoints | 1-2h |
| Auth middleware: operator token validation | 1h |
| Assignment semantics (claim/notify/timeout) | 2-3h |
| Bus-client reference implementation | 2-3h |
| Audit separation | 1h |
| Runbook and docs | 1h |
| Migration: remove Itachi/Shikamaru from seeded agents | 1h |

**Total: 10-14h.** Each deliverable is independently testable.
