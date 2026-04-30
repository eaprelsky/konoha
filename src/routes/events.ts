import { Hono } from "hono";
import { createLogger } from "../logger";
import { requireAuth } from "../middleware/auth";
import { publishEvent, type KonohaEvent } from "../redis";
import { listEvents, processEvent, listCases, listWorkItems, getCase, getWorkItem, handleEventFired, type Case, type HistoryEntry } from "../runtime";
import { getWorkflow, type WorkflowElement } from "../workflow-loader";
import { getMessengerConnectorCatalog, resolveMessengerWorkflowIds, type MessengerChatType, type MessengerMessageType } from "../messenger-connectors";
import { loadActiveWaitsForCase, resolveEventWaitForNode } from "../runtime/event-waits";
import { emitEvent } from "../runtime/event-log";
const log = createLogger("routes:events");

const router = new Hono();

// All routes require auth (set via app.use in server.ts)

router.post("/", async (c) => {
  const body = await c.req.json();
  const { type, source, payload, timestamp, village_id } = body;

  if (!type || typeof type !== "string") return c.json({ error: "type is required and must be a string" }, 400);
  if (!source || typeof source !== "string") return c.json({ error: "source is required and must be a string" }, 400);
  if (payload === undefined || typeof payload !== "object" || Array.isArray(payload)) return c.json({ error: "payload is required and must be an object" }, 400);
  if (!village_id || typeof village_id !== "string") return c.json({ error: "village_id is required and must be a string" }, 400);

  const event: KonohaEvent = {
    type,
    source,
    payload,
    timestamp: timestamp || new Date().toISOString(),
    village_id,
  };

  const id = await publishEvent(event);

  const workflowIds = resolveWorkflowScope(type, source, payload);

  // Trigger workflow runtime: find matching process definitions and create cases
  const cases = await processEvent(type, source, payload, workflowIds ? { workflowIds } : undefined).catch((e) => {
    log.error("processEvent error", { error: e.message, event_type: type, source });
    return [];
  });

  return c.json({ id, cases_created: cases.map((c: Case) => c.case_id), workflow_scope: workflowIds ?? null });
});

router.get("/log", async (c) => {
  const type = c.req.query("type") || undefined;
  const after = c.req.query("after") || undefined;
  const before = c.req.query("before") || undefined;
  const limit = Math.min(parseInt(c.req.query("limit") || "100"), 1000);
  const events = await listEvents({ type, after, before, limit });
  return c.json(events);
});

// Mining routes
export const miningRouter = new Hono();

miningRouter.get("/process/:id", async (c) => {
  const process_id = c.req.param("id");

  // Load workflow definition for designed elements and edges
  const wf = await getWorkflow(process_id).catch(() => null);
  const designedElements = new Set<string>(wf?.elements.map((e: WorkflowElement) => e.id) || []);
  const designedEdges = new Set<string>((wf?.flow || []).map((edge) => `${edge[0]}:${edge[1]}`));

  // Load all cases for this process
  const { cases } = await listCases({ process_id, limit: 1000 });

  // Per-element stats
  const elementVisits: Record<string, number> = {};
  const edgeCounts: Record<string, number> = {};

  for (const kase of cases) {
    const history = kase.history;
    for (const entry of history) {
      elementVisits[entry.element_id] = (elementVisits[entry.element_id] || 0) + 1;
    }
    // Edge traversal from consecutive history entries
    for (let i = 0; i < history.length - 1; i++) {
      const edgeKey = `${history[i].element_id}:${history[i + 1].element_id}`;
      edgeCounts[edgeKey] = (edgeCounts[edgeKey] || 0) + 1;
    }
  }

  // Load work items for duration analysis
  const workItems = await listWorkItems({ process_id });
  const durationsByElement: Record<string, number[]> = {};
  for (const wi of workItems) {
    if (!wi.element_id || wi.status !== "done") continue;
    const ms = new Date(wi.updated_at).getTime() - new Date(wi.created_at).getTime();
    if (ms < 0) continue;
    if (!durationsByElement[wi.element_id]) durationsByElement[wi.element_id] = [];
    durationsByElement[wi.element_id].push(ms);
  }

  function median(arr: number[]): number | null {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
  }
  function avg(arr: number[]): number | null {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  // Build per-element result
  const allElementIds = new Set([...designedElements, ...Object.keys(elementVisits)]);
  const elementStats: Record<string, {
    label: string; type: string;
    visit_count: number;
    avg_duration_ms: number | null;
    max_duration_ms: number | null;
    p50_duration_ms: number | null;
  }> = {};

  for (const id of allElementIds) {
    const el = wf?.elements.find((e: WorkflowElement) => e.id === id);
    const durations = durationsByElement[id] || [];
    elementStats[id] = {
      label: el?.label || id,
      type: el?.type || "unknown",
      visit_count: elementVisits[id] || 0,
      avg_duration_ms: avg(durations),
      max_duration_ms: durations.length ? Math.max(...durations) : null,
      p50_duration_ms: median(durations),
    };
  }

  // Bottleneck: highest avg_duration among function elements with data
  let bottleneckId: string | null = null;
  let maxAvg = -1;
  for (const [id, stat] of Object.entries(elementStats)) {
    if (stat.avg_duration_ms !== null && stat.avg_duration_ms > maxAvg) {
      maxAvg = stat.avg_duration_ms;
      bottleneckId = id;
    }
  }

  // Deviation: visited elements not in designed schema
  const deviationElements = Object.keys(elementVisits).filter(id => !designedElements.has(id));
  // Skipped: designed elements never visited across all cases
  const skippedElements = [...designedElements].filter(id => !elementVisits[id]);

  // Build edge result
  const allEdgeKeys = new Set([...designedEdges, ...Object.keys(edgeCounts)]);
  const edges: Record<string, { count: number; is_designed: boolean }> = {};
  for (const key of allEdgeKeys) {
    edges[key] = {
      count: edgeCounts[key] || 0,
      is_designed: designedEdges.has(key),
    };
  }

  return c.json({
    process_id,
    case_count: cases.length,
    elements: elementStats,
    edges,
    bottleneck_element_id: bottleneckId,
    deviation_elements: deviationElements,
    skipped_elements: skippedElements,
  });
});

miningRouter.get("/case/:id", async (c) => {
  const case_id = c.req.param("id");
  const kase = await getCase(case_id);
  if (!kase) return c.json({ error: "Case not found" }, 404);

  // Enrich history with work item durations
  const enriched = await Promise.all(kase.history.map(async (entry: HistoryEntry) => {
    if (!entry.work_item_id) return { ...entry, duration_ms: null };
    const wi = await getWorkItem(entry.work_item_id);
    const duration_ms = wi && wi.status === "done"
      ? new Date(wi.updated_at).getTime() - new Date(wi.created_at).getTime()
      : null;
    return { ...entry, duration_ms };
  }));

  // Include active EventWait records
  const active_waits = await loadActiveWaitsForCase(case_id);

  return c.json({
    case_id,
    process_id: kase.process_id,
    status: kase.status,
    created_at: kase.created_at,
    history: enriched,
    active_waits,
  });
});

// Dedicated endpoint for active waits per case
miningRouter.get("/case/:id/waits", async (c) => {
  const case_id = c.req.param("id");
  const kase = await getCase(case_id);
  if (!kase) return c.json({ error: "Case not found" }, 404);

  const waits = await loadActiveWaitsForCase(case_id);
  return c.json({ case_id, waits });
});

// Confirm a manual event — human confirms, case advances
miningRouter.post("/case/:id/confirm-event", async (c) => {
  const case_id = c.req.param("id");
  type ConfirmEventBody = { element_id?: string; comment?: string; confirmed_by?: string };
  const body = await c.req.json<ConfirmEventBody>().catch((): ConfirmEventBody => ({}));
  const kase = await getCase(case_id);
  if (!kase) return c.json({ error: "Case not found" }, 404);
  if (kase.status !== "running") return c.json({ error: "Case is not running" }, 409);

  const element_id = body.element_id || kase.position;
  if (kase.position !== element_id) {
    return c.json({ error: "Case is not waiting at this element", position: kase.position }, 409);
  }

  // Verify there's an active EventWait for this node
  const waits = await loadActiveWaitsForCase(case_id);
  const wait = waits.find(w => w.element_id === element_id);
  if (!wait) {
    return c.json({ error: "No active wait found for this element" }, 404);
  }
  if (wait.trigger_kind !== "manual") {
    return c.json({ error: "Only manual triggers can be confirmed", trigger_kind: wait.trigger_kind }, 400);
  }

  const def = await getWorkflow(kase.process_id);
  if (!def) return c.json({ error: "Workflow not found" }, 404);

  // Audit trail
  await emitEvent({
    type: "event.confirmed",
    case_id,
    process_id: kase.process_id,
    element_id,
    confirmed_by: body.confirmed_by || "api",
    comment: body.comment || "",
    timestamp: new Date().toISOString(),
  });

  // Resolve the EventWait and advance
  await resolveEventWaitForNode(case_id, element_id, { confirmed_by: body.confirmed_by, comment: body.comment });

  const { advanceCase } = await import("../runtime/cases/advancement");
  const updated = await advanceCase(kase, def);
  log.info("manual event confirmed, case advanced", { case_id, element_id, status: updated.status });

  return c.json({ ok: true, case_id, status: updated.status });
});

export default router;

function resolveWorkflowScope(type: string, source: string, payload: Record<string, unknown>): string[] | null {
  if (source !== "telegram" || !type.startsWith("telegram.")) return null;
  const endpointId = stringField(payload.endpoint_id);
  const chatRef = stringField(payload.chat_ref ?? payload.chat_id);
  if (!endpointId || !chatRef) return null;
  return resolveMessengerWorkflowIds(getMessengerConnectorCatalog(), {
    endpoint_id: endpointId,
    chat_ref: chatRef,
    chat_type: messengerChatType(payload.chat_type),
    message_type: messengerMessageType(payload.message_type),
    command: stringField(payload.command),
    text: stringField(payload.text),
    event_kind: stringField(payload.event_kind),
  });
}

function stringField(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function messengerChatType(value: unknown): MessengerChatType | undefined {
  if (value === "direct" || value === "group" || value === "channel" || value === "unknown") return value;
  return undefined;
}

function messengerMessageType(value: unknown): MessengerMessageType | undefined {
  if (value === "text" || value === "command" || value === "photo" || value === "document" || value === "reaction" || value === "unknown") return value;
  return undefined;
}
