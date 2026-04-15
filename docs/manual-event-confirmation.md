# Manual Event Confirmation — UX Design Note

> Issue: #494 | Status: Draft | Date: 2026-04-15

## Overview

When a running Case arrives at a manual event node (e.g. "Согласование менеджера", "Проверка документа"), the process pauses until a human confirms. This document defines the UX surfaces, confirmation contract, and permission model.

## Scenarios

| # | Scenario | trigger_kind | Example |
|---|----------|-------------|---------|
| 1 | Approval gate | manual (action=approve/reject) | "Согласование договора" |
| 2 | Data submission | manual (action=submit) | "Заполнение отчёта" |
| 3 | Review checkpoint | manual (action=complete) | "Проверка качества" |
| 4 | Escalation confirmation | manual (action=escalate) | "Эскалация руководителю" |

## Existing Backend

The confirm-event endpoint already exists:

```
POST /api/events/mining/case/:id/confirm-event
Body: { element_id?, comment?, confirmed_by? }
```

EventWait entity tracks: `wait_id`, `case_id`, `process_id`, `element_id`, `status`, `deadline`, `assignee`, `reminder_count`, `escalation_target`.

## UI Surfaces

### 1. Case Detail View

**Where:** Case page (`/cases/:id`) — main view of a running case.

**What to show when case is waiting at a manual event:**
- Breadcrumb status indicator: "Ожидание подтверждения" with amber/yellow badge
- EventWait card at current position showing:
  - `element_label` — what needs confirming
  - `assignee` — who is responsible (or "Не назначен")
  - `deadline` — countdown timer if set, red if overdue
  - `reminder_count` — number of reminders sent
- **Confirm button** — primary action, visible only if user has permission
- **Comment field** — optional, captured as `comment` in confirm-event payload
- **Reject button** — optional, for approve/reject scenarios

### 2. Wait List (Inbox)

**Where:** Dedicated view or section in the dashboard (`/waits` or `/inbox`).

**What to show:**
- List of active EventWaits assigned to current user (or all if admin)
- Columns: Process Name | Event | Deadline | Status | Reminder Count
- Quick confirm from list (one-click for simple approvals)
- Filter: by process, by assignee, by deadline proximity

### 3. Notifications

**Channels (in priority order):**

| Channel | Trigger | Content |
|---------|---------|---------|
| GUI (in-app) | EventWait created | "Требуется подтверждение: {element_label}" with link to case |
| GUI reminder | PingPolicy schedule | "Напоминание ({n}): {element_label}" |
| Telegram | escalation_target = telegram | Same text via bot DM to assignee |
| Email | escalation_target = email | Full details with confirm link |

### 4. Overdue & Escalation Flow

```
active → overdue (deadline passed)
              ↓
         escalated (escalation_target notified)
              ↓
         notify | reassign | abort
```

**Overdue indicator:** Red badge + "Просрочено" label in wait list and case view.

**Escalation actions:**
- `notify` — send message to escalation_target, keep waiting
- `reassign` — change assignee to escalation_target
- `abort` — cancel wait, mark case as error

## Confirmation Contract

### Request

```typescript
interface ConfirmEventRequest {
  element_id?: string;    // defaults to current position
  comment?: string;       // free-text note
  confirmed_by: string;   // user ID (required)
  artifacts?: {           // optional attachments
    name: string;
    url: string;
  }[];
  outcome?: "approved" | "rejected";  // for approval gates
}
```

### Response

```typescript
interface ConfirmEventResponse {
  ok: boolean;
  case_id: string;
  status: "running" | "done" | "error";  // case status after advancement
  next_element?: {
    element_id: string;
    type: string;
    label: string;
  };
}
```

### Audit Trail

Every confirmation emits an `event.confirmed` event to the event log:

```typescript
{
  type: "event.confirmed",
  case_id: string;
  process_id: string;
  element_id: string;
  confirmed_by: string;
  comment: string;
  outcome: string;
  timestamp: string;
}
```

## Permission Model

### Who can confirm?

1. **Assigned user** — `EventWait.assignee` matches the confirming user. Always allowed.
2. **Process owner** — user listed as owner/admin of the process definition.
3. **System admin** — users with admin role in Konoha.

### Rule: anyone in the responsible role

If no specific `assignee` is set, any user with the role specified on the event node element (`element.role`) can confirm.

### Authorization check

```
can_confirm(user, event_wait):
  if user.id == event_wait.assignee → YES
  if user.role == event_wait.element.role → YES
  if user.is_admin → YES
  → NO
```

### Edge cases

- **No assignee, no role:** Only system admins can confirm.
- **Confirmation while overdue:** Allowed — confirmation clears overdue/escalated status.
- **Double confirmation:** Second confirm returns 409 (case already advanced). Frontend should refresh case state.
- **Concurrent confirmations:** Idempotency is guaranteed by position check in `handleEventFired`.

## Required UI Surfaces (Summary)

| Surface | Priority | Implementation |
|---------|----------|---------------|
| Case detail: confirm card + button | P0 | Frontend: CaseView component |
| Wait list / inbox | P1 | Frontend: new WaitsView page |
| In-app notification | P1 | Frontend: notification bell + SSE |
| Overdue badge + styling | P2 | Frontend: CSS conditional classes |
| Telegram notification | P2 | Backend: konoha_send via bot |
| Reject outcome | P2 | Backend: extend confirm-event with outcome field |

## Dependencies

- ADR-001 EventWait Runtime Entity (issue #491) — **DONE**
- Confirm-event API endpoint — **DONE** (`POST /events/mining/case/:id/confirm-event`)
- Event log for audit trail — **DONE** (`emitEvent`)
- Overdue sweep scheduler — **DONE** (`sweepOverdueWaits`)
