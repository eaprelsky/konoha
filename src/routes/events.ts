import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { publishEvent, type KonohaEvent } from "../redis";
import { listEvents, processEvent, listCases, listWorkItems, getCase, getWorkItem, type Case, type HistoryEntry } from "../runtime";
import { getWorkflow, type WorkflowElement } from "../workflow-loader";

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

  // Trigger workflow runtime: find matching process definitions and create cases
  const cases = await processEvent(type, source, payload).catch((e) => {
    console.error("[runtime] processEvent error:", e.message);
    return [];
  });

  return c.json({ id, cases_created: cases.map((c: Case) => c.case_id) });
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

  return c.json({
    case_id,
    process_id: kase.process_id,
    status: kase.status,
    created_at: kase.created_at,
    history: enriched,
  });
});

export default router;
