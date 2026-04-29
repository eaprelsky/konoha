# ADR-002: Tsunade New-Process Materialization — Root Cause & Target Architecture

> Issue: #525 | Priority: P1 | Date: 2026-04-15 | Author: Kakashi
> Status: Decision Packet — awaiting Egor's review

## 2026-04-29 Status Update

Phase 1-3 have partially landed:
- `/api/ai/chat` is the canonical assistant endpoint for process-mode workflow operations.
- Non-streaming process responses now use the same canonical assistant envelope as streaming parsed events: `created_workflow`, `actions_taken`, `action_receipts`, `observable_result`, and `pending_confirmations`.
- `api.assistant.chat({ mode: "process", ... })` is the preferred frontend client path. `api.tsunade.chat()` and `api.tsunade.processChat()` remain compatibility shims that call `/api/ai/chat`.
- Legacy backend routes `/tsunade/chat` and `/ai/process-chat` are still active compatibility endpoints for external callers, but new UI code should not target them directly.

The root-cause analysis below is preserved as historical context from 2026-04-15. Treat statements about missing `created_workflow` frontend types as pre-fix context, not the current implementation.

## 1. Architecture Map — End-to-End Trace

### UI Entry Points (two active, one dead)

```
Entry Point A: AssistantWidget (global, fixed, SSE streaming)
  └── useAssistantChat.ts → POST /api/ai/chat { stream: true, mode: "process" }
      └── SSE delta → extractStreamingText() → shows partial text in chat
      └── SSE parsed → handles created_workflow ✓
          └── window.dispatchEvent('konoha:workflow_created')
              └── ProcessEditor.tsx loads new workflow via loadWorkflow(id)
          └── navigate(/editor/:id) if not already in editor ✓

Entry Point B: TsunadeChatPanel (legacy, inside ProcessEditor, non-streaming)
  └── api.assistant.chat({ mode: "process" }) → POST /api/ai/chat { NO stream }
      └── canonical assistant envelope
      └── handles schema_patch, created_workflow, action_receipts, observable_result, pending_confirmations

Entry Point C: /tsunade/chat (legacy HTTP endpoint, used by old chat)
  └── Compatibility backend path
  └── Returns the canonical assistant envelope
  └── Frontend shims should prefer /api/ai/chat
```

### Backend Response Contract (actual, not declared)

Non-streaming process chat (`POST /api/ai/chat`, with legacy shims still supported):
```typescript
{
  reply: string;                    // human-readable text
  chat_id: string;
  schema_patch: SchemaPatch | null; // patch to current workflow
  created_workflow: WorkflowDef | null;
  actions: HighlightAction[];
  actions_taken: WorkflowAssistantAction[];
  action_receipts: WorkflowActionReceipt[];
  observable_result: WorkflowObservableResult;
  pending_confirmations: WorkflowPendingConfirmation[];
}
```

Streaming (`POST /api/ai/chat { stream: true }`):
```
SSE events:
  type: "chat_id"  → { chat_id }
  type: "delta"    → { text }         // raw LLM text chunks (may be JSON)
  type: "parsed"   → { reply, schema_patch, created_workflow, actions }
  type: "error"    → { message }
  [DONE]
```

### LLM Response Contract (prompt-enforced)

System prompt says: `"отвечай ТОЛЬКО валидным JSON. Без markdown-оберток."`

Expected JSON shape:
```json
{
  "reply": "human-readable response",
  "create_workflow": { ... WorkflowDefinition ... },
  "schema_patch": { ... },
  "actions": [ ... ]
}
```

### Data Flow Diagram

```
User: "Создай процесс согласования договоров"
  │
  ├─→ [AssistantWidget] ──POST /api/ai/chat──→ [stream mode]
  │     │                                       │
  │     │   SSE: delta chunks                   │  LLM outputs JSON
  │     │   (raw JSON visible during stream!)   │  with create_workflow key
  │     │                                       │
  │     │   SSE: parsed event                   │  Backend:
  │     │     { reply, created_workflow }        │    JSON.parse(fullText)
  │     │                                       │    createWorkflow(def, {draft:true})
  │     │   Frontend:                           │    → Redis + PG + schema registry
  │     │     dispatch konoha:workflow_created   │
  │     │     navigate(/editor/:id)              │
  │     │     ✅ Materializes in editor         │
  │
  └─→ [TsunadeChatPanel] ──POST /ai/process-chat──→ [non-stream]
        │                                            │
        │   Response: { reply, created_workflow }    │  Same backend
        │                                            │
        │   Frontend:                                │
        │     Only reads schema_patch                │
        │     ❌ created_workflow DROPPED             │
        │     ❌ Shows raw reply (may contain JSON)  │
        │     ❌ No navigation to editor             │
```

## 2. Root Cause Analysis

### Root Cause #1: Legacy panel ignores created_workflow

**File:** `frontend/src/pages/TsunadeChatPanel.tsx:69-86`

The legacy panel uses `api.tsunade.processChat()` whose TypeScript return type is:
```typescript
apiFetch<{ reply: string; chat_id: string; schema_patch: unknown | null; actions?: HighlightAction[] }>
```

This type **does not include `created_workflow`**. Even though the backend returns it, the frontend:
1. Doesn't declare the type → TypeScript doesn't know about it
2. Doesn't read `res.created_workflow` from the response
3. Doesn't dispatch `konoha:workflow_created` event
4. Doesn't navigate to the editor

**Impact:** If a user is in ProcessEditor and uses the legacy TsunadeChatPanel to ask "create a new process", the workflow IS created in the backend (Redis + PG), but the UI shows the reply text and does NOT navigate to the new process.

### Root Cause #2: Streaming shows raw JSON during delta phase

**File:** `frontend/src/hooks/useAssistantChat.ts:26-34`

During SSE streaming, `delta` events contain raw LLM output tokens. The `extractStreamingText()` function tries to extract the `"reply"` field from partial JSON:

```typescript
function extractStreamingText(raw: string): string {
  const m = raw.match(/"reply"\s*:\s*"([\s\S]*)/);
  if (!m) return raw;  // ← if regex fails, raw JSON shown to user
  // ...
}
```

When the LLM outputs `{"reply": "...", "create_workflow": {...}}`, during the stream the user sees partial JSON like `{"reply": "Я создал процесс", "create_` before the `parsed` event arrives.

The regex `/"reply"\s*:\s*"([\s\S]*)/` breaks when:
- The reply value contains escaped quotes or newlines
- The JSON structure doesn't have a `"reply"` key (e.g. LLM uses `"text"` or outputs malformed JSON)
- The LLM wraps in markdown fences despite the prompt saying not to

**Impact:** User sees raw JSON tokens in the chat during streaming. The `parsed` event eventually replaces it with clean text, but the flash of JSON is a bad UX.

### Root Cause #3: LLM JSON parse failure = raw JSON shown permanently

**File:** `src/routes/ai.ts:528-545` (streaming) and `:229-242` (non-streaming)

```typescript
try {
  const parsed = JSON.parse(stripMarkdownFences(fullText));
  // ... extract reply, create_workflow ...
} catch { /* not JSON — delta stream is fine as-is */ }
```

If the LLM output is not valid JSON (partial JSON, text with JSON fragments, hallucinated format), the catch block silently falls through. In streaming mode, the delta chunks remain as-is — the user sees the raw LLM output permanently.

**Impact:** The user's chat shows the full JSON payload as the "reply", with no human-readable text and no workflow creation.

### Root Cause #4: Dual-path architecture (streaming vs non-streaming)

The system has **two partially overlapping paths**:
- `AssistantWidget` → `/api/ai/chat` (stream=true) → handles `created_workflow`
- `TsunadeChatPanel` → `/api/ai/process-chat` (no stream) → ignores `created_workflow`

Both call the same backend logic, but with different contracts and different frontend handling. The legacy panel was extracted from ProcessEditor but was never updated for workflow creation.

### Missing Invariants

1. **No guarantee that LLM outputs valid JSON** — prompt says "ТОЛЬКО JSON" but there's no enforcement
2. **No server-side normalization** — backend passes raw LLM text to frontend instead of structured envelope
3. **No type sharing** — backend response shape and frontend types are maintained independently
4. **No end-to-end test** — no test verifies user→LLM→parse→create→navigate→editor flow
5. **Tsundade is not a first-class operator** — she's a chatbot that happens to output JSON, not an agent with actions, permissions, and observable state

## 3. Design Proposal — Target Architecture

### Guiding Principle (from Egor)

> Tsunade must be a first-class user/operator of the application. Not text-to-JSON UX, but a full action surface with rights, confirmations, observable state, and the ability to complete process setup to a result within the system.

### Target Contract: Action-Based Assistant

Instead of LLM outputting JSON that the frontend parses, Tsunade should use the **act-envelope** system (issue #503):

```
User: "Создай процесс согласования договоров"
  │
  └─→ Backend (ai.ts):
        1. LLM generates response with intent + params
        2. Backend normalizes into ActEnvelope or IntentPlan
        3. Backend executes server-side (createWorkflow, etc.)
        4. Backend returns structured response:
           {
             reply: "Создан процесс...",
             actions_taken: [
               { action: "workflow.create", result: { id: "..." }, status: "ok" }
             ],
             workflow_id: "new-process-id",
             requires_confirmation: false
           }
  │
  └─→ Frontend:
        1. Receives clean structured response (no raw JSON)
        2. Actions_taken triggers UI reactions:
           - workflow.create → navigate to editor
           - schema_patch → apply patch
           - highlight → show highlight
        3. Confirmation UX for destructive actions
```

### Key Changes

#### A. Server-Side Intent Normalization (not frontend parsing)

```typescript
// New: src/routes/ai-assistant-actions.ts
interface AssistantAction {
  type: "workflow.create" | "workflow.update" | "element.add" | "flow.add" | "confirm";
  params: Record<string, unknown>;
  status: "pending" | "executed" | "needs_confirm" | "failed";
  result?: unknown;
}

interface AssistantResponse {
  reply: string;                          // always clean text
  chat_id: string;
  actions: AssistantAction[];             // structured, not raw JSON
  workflow_id?: string;                   // convenience for frontend
}
```

#### B. Unify Entry Points

Remove `TsunadeChatPanel` as a separate chat path. The `AssistantWidget` (with `useAssistantChat`) becomes the sole chat interface. The panel inside ProcessEditor becomes a view-mode toggle for the widget, not a separate HTTP path.

#### C. LLM → Action Translation Layer

The LLM's job is to express intent, not to produce machine-readable transport format:

```
Current:  LLM outputs JSON → backend parses → frontend receives raw JSON
Target:   LLM outputs intent → backend normalizes → backend executes → frontend receives clean result
```

Use the intent-decomposer from #503 as the translation layer. The LLM prompt asks for structured intents, and the backend maps them to actions via the registry.

#### D. Confirmation & Permission Surface

For workflow creation and mutations:
- `workflow.create` → executed immediately (draft mode), confirmation shown in UI
- `workflow.deploy` → requires explicit user confirmation (destructive)
- `workflow.delete` → requires explicit confirmation
- Permissions: Tsunade acts on behalf of the requesting user, inherits their permissions

#### E. Observable State

Every action creates an audit trail:
```typescript
// Already exists: auditLog() in assistant-actions.ts
// Extend to cover workflow.create, workflow.deploy
```

Tsunade's actions are visible in:
- Inspector timeline
- Konoha bus events (agent_action_executed)
- Case/event-wait system for manual confirmations

## 4. Implementation Plan

### Phase 1: Stop the bleeding (immediate, low risk)

1. **Fix TsunadeChatPanel** — add `created_workflow` handling:
   - Update `api.tsunade.processChat()` type to include `created_workflow`
   - Read `res.created_workflow` in TsunadeChatPanel
   - Dispatch `konoha:workflow_created` event
   - Navigate to editor
   - ~30 min, zero architecture change

2. **Fix streaming delta display** — don't show raw JSON during stream:
   - In `extractStreamingText()`, if the text looks like JSON, show a loading state instead
   - Only show final text from `parsed` event
   - ~1 hour

### Phase 2: Server-side normalization (1-2 days)

3. **Create `normalizeAssistantResponse()`** in backend:
   - Takes raw LLM text
   - Extracts intents/actions using regex + JSON parse
   - Executes actions server-side (via act-envelope or intent-decomposer)
   - Returns clean `AssistantResponse` with `actions_taken[]`

4. **Remove LLM JSON dependency from frontend**:
   - Frontend receives `{ reply, actions_taken, workflow_id }` — never raw LLM text
   - Frontend reacts to `actions_taken` items, not parsed JSON fields

### Phase 3: Unify entry points (2-3 days)

5. **Deprecate `/ai/process-chat`** — keep it as a compatibility route while new clients use `/api/ai/chat` with `mode: "process"`
6. **Remove `TsunadeChatPanel` as separate component** — future cleanup: replace it with a docked mode of `AssistantWidget`
7. **Single assistant path** — all new workflow chat goes through `/api/ai/chat`; streaming remains preferred for the global widget

### Phase 4: First-class operator surface (1 week)

8. **Action permissions** — Tsunade actions go through `checkAutonomy()` from act-envelope
9. **Confirmation UX** — destructive actions show confirmation dialog before executing
10. **Observable state** — all assistant actions logged to audit trail + Konoha bus
11. **End-to-end tests** — `user asks new process → workflow created → editor opened → saved`

## 5. Test Strategy

### Unit tests (Phase 1)
- `extractStreamingText()` — JSON-like input → loading state, not raw text
- `TsunadeChatPanel` — response with `created_workflow` → dispatches event + navigates
- `api.tsunade.processChat()` type — includes `created_workflow`

### Integration tests (Phase 2)
- `normalizeAssistantResponse()` — various LLM output formats → clean `AssistantResponse`
- `POST /api/ai/chat` — stream mode → `parsed` event always has clean `reply`
- Workflow creation via assistant → Redis + PG + schema registry populated

### E2E tests (Phase 3-4)
- `user asks "create process" → workflow created → editor opened → draft saved`
- `user asks "create process" → malformed LLM output → graceful fallback, no raw JSON`
- `user asks destructive action → confirmation shown → user confirms → action executed`

## 6. Architectural Direction — Agent-Friendly Application Framework

> "Приложение должно быть AI-agent-friendly: не raw DOM как объект парсинга, а agent-readable/actionable surface с состоянием, affordances, permissions, confirmations и observable result." — Egor

This issue is not just a Tsunade fix — it reveals a **framework-level gap**. The application needs a first-class concept of "agent surface" — a structured, machine-readable interface that AI agents (Tsunade, future agents) can interact with.

### Target Model: Agent Action Surface

```
Current:
  User → Chat → LLM → raw text/JSON → frontend parses → maybe works

Target:
  User → Chat → LLM → Intent → Action Registry → structured result → UI reacts
                                         ↑
                              Agent Action Surface (new)
                              ├── State: what the agent sees (Inspector snapshot, workflow state)
                              ├── Affordances: what the agent can do (action registry)
                              ├── Permissions: what the agent is allowed (autonomy levels)
                              ├── Confirmations: what requires human approval
                              └── Observable Result: audit trail + state change notification
```

### Five Pillars of Agent-Friendly Architecture

| Pillar | Current State | Target |
|--------|---------------|--------|
| **State** | Inspector snapshot (ad-hoc, string-based) | Structured application state API with agent-scoped views |
| **Affordances** | Implicit in system prompt ("you can do X") | Explicit action registry with contracts (#503 act-envelope) |
| **Permissions** | None — agent can do anything the user can | Autonomy levels: disabled / confirm / autonomous per action |
| **Confirmations** | None — fire-and-forget | Confirmation UX with preview, undo window, audit log |
| **Observable Result** | Chat reply only | Action result objects + state change events + audit trail |

### Why This Matters Beyond Tsunade

1. **Any agent** (Tsunade, Kiba, future custom agents) needs the same surface
2. **Tool use / function calling** from LLMs maps directly to the action registry
3. **MCP servers** expose the same actions — one registry, multiple interfaces
4. **Autonomous mode** requires permissions + confirmations as guardrails
5. **Debugging** requires observable results — "what did the agent do and why?"

### Implementation Trajectory

This framework emerges naturally from the phased plan:
- Phase 2 (server-side normalization) → creates the **Affordances** pillar
- Phase 3 (unify entry points) → creates the **State** pillar (Inspector as agent view)
- Phase 4 (first-class operator) → creates **Permissions**, **Confirmations**, **Observable Result**

The action registry from #503 is already the foundation. The intent-decomposer translates LLM text into registry actions. What's missing is the permission/confirmation/observability layer on top.

## 7. Recommended First Step

**Phase 1, Item 1** — Fix TsunadeChatPanel to handle `created_workflow`. This is the smallest change that directly fixes the reported symptom. After that, Phase 1 Item 2 fixes the streaming flash.

These are safe fixes that don't change architecture — they just close the gaps in the existing paths. The architectural work (Phase 2-4) follows after the packet is reviewed.
