# Event System — Technical Reference

The event system connects eEPC process diagrams to real-world triggers. It consists of three layers:

1. **Trigger Resolver** — classifies event labels into structured trigger descriptors using an LLM
2. **Event Manager** — stores subscriptions and fires events at the right moment
3. **Data Adapters** — bridge external systems (Bitrix24, Telegram, Tracker) to the Event Manager

---

## Trigger Resolver

`src/trigger-resolver.ts`

When a process is deployed, each event in the diagram has a text label (e.g. "Заявка получена от клиента", "Каждый понедельник в 9:00"). The Trigger Resolver sends these labels to Claude Haiku with prompt caching and gets back a structured `TriggerDescriptor`.

### Trigger types

| Kind | Description | Required fields |
|------|-------------|-----------------|
| `timer` | Scheduled or delayed | `cron` (cron string) OR `delay_after` (object with `ref_event` + `duration` in ISO 8601) |
| `message` | Incoming event from external system | `source`, `filter` |
| `condition` | Fires when a data metric crosses a threshold | `data_source`, `query` (entity, filter, metric), `operator`, `threshold`, `poll_interval` |
| `manual` | Human action | `action` (approve/reject/submit/complete/escalate), `role` |
| `system` | Internal workflow engine event | `event_name` (process_completed, process_error, subprocess_completed, function_completed, all_branches_completed) |
| `ambiguous` | LLM could not determine type | `candidates` (array of options with confidence) |

All descriptors include a `confidence` field (0.0–1.0).

Known external sources for `message` and `condition` triggers: `bitrix`, `telegram`, `tracker`, `bus`, `webhook`.

### Programmatic API

Used internally by the workflow deploy flow. Throws if the LLM is unavailable — deployment aborts.

```ts
import { resolveBatchProgrammatic } from "./trigger-resolver";

const results = await resolveBatchProgrammatic(
  [
    { id: "e1", label: "Каждый понедельник в 9:00" },
    { id: "e2", label: "Клиент заполнил форму", manual_override: false },
    { id: "e3", label: "Согласовано руководителем", manual_override: true },
  ],
  { process_id: "proc-1", process_name: "Онбординг", events: [...], functions: [...] }
);
// results[2].trigger === null  (manual_override skips LLM)
```

### HTTP endpoints

#### POST /api/trigger-resolver/resolve

Resolve a single event label.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "Каждый понедельник в 9:00"}' \
  http://127.0.0.1:3200/api/trigger-resolver/resolve
```

Response:
```json
{
  "trigger": { "kind": "timer", "cron": "0 9 * * 1", "confidence": 0.97 },
  "raw_label": "Каждый понедельник в 9:00"
}
```

Set `manual_override: true` to skip LLM — returns `{ "trigger": null, "skipped": true }`.

#### POST /api/trigger-resolver/resolve-batch

Resolve multiple events in one call. Returns results in the same order as input.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {"id": "e1", "label": "Заявка поступила в Битрикс"},
      {"id": "e2", "label": "Количество открытых лидов превысило 50"}
    ],
    "process_context": {"process_id": "p1", "process_name": "Обработка лидов"}
  }' \
  http://127.0.0.1:3200/api/trigger-resolver/resolve-batch
```

Response:
```json
{
  "results": [
    {"id": "e1", "trigger": {"kind": "message", "source": "bitrix", "filter": {"entity": "lead", "event": "onCrmLeadAdd"}, "confidence": 0.95}},
    {"id": "e2", "trigger": {"kind": "condition", "data_source": "bitrix", "query": {"entity": "lead", "filter": {}, "metric": "count"}, "operator": ">", "threshold": 50, "poll_interval": "PT5M", "confidence": 0.88}}
  ]
}
```

---

## Event Manager

`src/event-manager.ts`

The Event Manager:
- Stores subscriptions in Redis (`event-manager:subscriptions`)
- Creates cron jobs (via `node-cron`) for `timer` triggers
- Activates listeners via DataAdapters for `message` and `condition` triggers
- Publishes `event_fired` messages on the Konoha bus when a trigger fires
- Keeps an event history ring buffer (last 500 entries) in `event-manager:history`

Each subscription links a trigger descriptor to a target Konoha agent or process run.

### Subscription lifecycle

1. Client calls `POST /api/event-manager/subscribe` with a trigger descriptor + target
2. Event Manager saves the subscription to Redis
3. Depending on trigger kind:
   - `timer`: schedules a cron job or a one-time delay job (via BullMQ)
   - `message`: calls `adapter.setupListener(filter, callback)` on the matching adapter
   - `condition`: starts a polling BullMQ job that calls `adapter.executeQuery(query)` on each tick
4. When the trigger fires, Event Manager sends `{ type: "event_fired", subscription_id, payload }` to the target agent via Konoha bus
5. Client calls `DELETE /api/event-manager/subscribe/:id` when done

### HTTP endpoints

#### POST /api/event-manager/subscribe

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "trigger": {"kind": "timer", "cron": "0 9 * * 1", "confidence": 0.97},
    "target": "naruto",
    "process_id": "proc-1",
    "event_id": "e1"
  }' \
  http://127.0.0.1:3200/api/event-manager/subscribe
```

Response:
```json
{
  "id": "sub-uuid",
  "status": "active",
  "next_fire_at": "2026-04-13T09:00:00.000Z"
}
```

#### DELETE /api/event-manager/subscribe/:id

Cancel a subscription and remove its cron/listener.

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/api/event-manager/subscribe/sub-uuid
```

#### GET /api/event-manager/subscriptions

List all active subscriptions.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3200/api/event-manager/subscriptions
```

---

## Data Adapters

`src/adapters/`

Each adapter implements the `DataAdapter` interface:

```ts
interface DataAdapter {
  readonly name: string;
  setupListener(filter, callback): Promise<ListenerHandle>;
  removeListener(handle): Promise<void>;
  executeQuery(query): Promise<number>;
}
```

### Available adapters

| Adapter | Source ID | Capabilities |
|---------|-----------|--------------|
| `bitrix` | `bitrix` | CRM leads/deals/tasks (webhook push) |
| `telegram-bot` | `telegram` | Bot messages (Grammy long-poll) |
| `tracker` | `tracker` | Yandex Tracker issues/comments |

Listeners are registered in the shared in-memory `listenerRegistry` (Map). Webhook routes dispatch incoming payloads to matching listeners.

### Adapter health

```bash
# List all adapters
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/adapters

# Check specific adapter
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3200/adapters/bitrix/health
# 200: {"adapter": "bitrix", "healthy": true}
# 503: {"adapter": "bitrix", "healthy": false}
```

### Bitrix24 webhook

Bitrix24 pushes events to `POST /api/webhooks/bitrix`. The adapter dispatches the payload to all matching listeners registered for the `bitrix` source.

---

## Event flow: end to end

```
eEPC diagram deployed
  → Trigger Resolver classifies each event label → TriggerDescriptor
  → Event Manager creates subscription for each trigger
      timer     → node-cron job / BullMQ delay
      message   → DataAdapter listener (webhook / long-poll)
      condition → BullMQ polling job → adapter.executeQuery()
  → Trigger fires
      → event_fired message sent to target agent via Konoha bus
      → entry appended to event-manager:history
  → Agent processes the event, advances the process run
```
