import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  loadWorkflows,
  getWorkflow,
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  archiveWorkflow,
  listWorkflowVersions,
  getWorkflowVersion,
} from "../workflow-loader";
import { normalizeElementNames } from "../normalizer";
import { join } from "path";
import { resolveBatchProgrammatic, type ProcessContext } from "../trigger-resolver";
import { createSubscriptionProgrammatic } from "../event-manager";

/**
 * Run Trigger Resolver batch for all event nodes that lack a `trigger` field.
 * Writes resolved triggers back into the elements array.
 * Returns { needs_review: true } if any event resolved to ambiguous or confidence < 0.7.
 * Throws if Haiku is unavailable (deploy must fail).
 */
async function resolveTriggers(
  elements: any[],
  processContext?: ProcessContext,
): Promise<{ elements: any[]; needs_review: boolean }> {
  const { buildAdjacency } = await import("../workflow-loader").then(m => {
    // Re-use buildAdjacency via a small local helper to identify start nodes
    return { buildAdjacency: null };
  });

  // Build edge maps inline to identify event nodes needing resolve
  const outCount = new Map<string, number>();
  const inCount = new Map<string, number>();
  for (const el of elements) { outCount.set(el.id, 0); inCount.set(el.id, 0); }

  const updatedElements = [...elements];

  const eventsToResolve = updatedElements
    .filter(el => el.type === "event" && !el.trigger?.kind && !el.trigger?.manual_override);

  if (eventsToResolve.length === 0) return { elements: updatedElements, needs_review: false };

  const ctx: ProcessContext = processContext ?? {};
  const results = await resolveBatchProgrammatic(
    eventsToResolve.map(el => ({ id: el.id, label: el.label, manual_override: el.trigger?.manual_override })),
    ctx,
  );

  let needs_review = false;
  const resultMap = new Map(results.map(r => [r.id, r.trigger]));

  for (let i = 0; i < updatedElements.length; i++) {
    const el = updatedElements[i];
    if (el.type !== "event") continue;
    const resolved = resultMap.get(el.id);
    if (!resolved) continue;

    updatedElements[i] = { ...el, trigger: resolved };

    if (resolved.kind === "ambiguous" || (resolved.confidence ?? 1) < 0.7) {
      needs_review = true;
    }
  }

  return { elements: updatedElements, needs_review };
}

/**
 * Subscribe all start event nodes (no incoming edges) of a process to Event Manager.
 * Called after a successful non-draft deploy.
 */
async function subscribeStartEvents(def: any): Promise<void> {
  // Build inEdge count
  const inCount = new Map<string, number>();
  for (const el of def.elements) inCount.set(el.id, 0);
  for (const [, to] of def.flow ?? []) inCount.set(to, (inCount.get(to) ?? 0) + 1);

  const startEvents = def.elements.filter((el: any) =>
    el.type === "event" && (inCount.get(el.id) ?? 0) === 0 && el.trigger?.kind && !el.trigger?.manual_override,
  );

  for (const el of startEvents) {
    try {
      await createSubscriptionProgrammatic({
        event_id: el.id,
        process_id: def.id,
        instance_id: "new", // no instance yet — engine will create one on event_fired
        trigger: el.trigger,
      });
      console.log(`[workflow-deploy] subscribed start event ${el.id} for process ${def.id}`);
    } catch (e: any) {
      console.error(`[workflow-deploy] failed to subscribe start event ${el.id}: ${e.message}`);
    }
  }
}

const router = new Hono();

router.get("/", requireAuth, async (c) => {
  const workflows = await listWorkflows();
  return c.json(workflows);
});

// NOTE: /versions sub-route must be declared BEFORE the wildcard get below
router.get("/:id{.+}/versions", requireAuth, async (c) => {
  const id = c.req.param("id");
  const versions = await listWorkflowVersions(id);
  return c.json(versions);
});

// :id{.+} captures slashes so IDs like "general/reflection" work correctly
router.get("/:id{.+}", requireAuth, async (c) => {
  const id = c.req.param("id");
  const snapshot = c.req.query("snapshot");
  if (snapshot) {
    const vwf = await getWorkflowVersion(id, snapshot);
    if (!vwf) return c.json({ error: "Snapshot not found" }, 404);
    return c.json(vwf);
  }
  const wf = await getWorkflow(id);
  if (!wf) return c.json({ error: "Workflow not found" }, 404);
  return c.json(wf);
});

router.post("/", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  if (!body.id || !body.name) return c.json({ error: "id and name required" }, 400);
  const draft = c.req.query("draft") === "true";
  let normalized = false;
  if (body.elements?.length) {
    const nameMap = await normalizeElementNames(body.elements).catch(() => ({}));
    if (Object.keys(nameMap).length) {
      body.elements = body.elements.map((el: any) => nameMap[el.id] ? { ...el, label: nameMap[el.id] } : el);
      normalized = true;
    }
  }

  // On non-draft deploy: resolve triggers for event nodes, save before making available
  if (!draft && body.elements?.length) {
    try {
      const ctx: ProcessContext = {
        process_id: body.id,
        process_name: body.name,
        events: body.elements.filter((el: any) => el.type === "event").map((el: any) => ({ id: el.id, label: el.label })),
        functions: body.elements.filter((el: any) => el.type === "function").map((el: any) => ({ id: el.id, label: el.label })),
      };
      const { elements, needs_review } = await resolveTriggers(body.elements, ctx);
      body.elements = elements;
      if (needs_review) {
        (body as any).status = "needs_review";
      }
    } catch (e: any) {
      console.error(`[workflow-deploy] trigger resolve failed: ${e.message}`);
      return c.json({ error: `Trigger resolve failed (Haiku unavailable): ${e.message}` }, 503);
    }
  }

  const result = await createWorkflow(body, { draft });
  if (result.errors.length > 0) return c.json({ error: "Validation failed", details: result.errors }, 422);

  // Subscribe start events on successful non-draft deploy without needs_review
  if (!draft && !(result.workflow as any).status?.includes("needs_review")) {
    subscribeStartEvents(result.workflow).catch(e =>
      console.error(`[workflow-deploy] subscribeStartEvents error: ${e.message}`),
    );
  }

  return c.json({ ...result.workflow, normalized }, 201);
});

router.put("/:id{.+}", requireAuth, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const draft = c.req.query("draft") === "true";
  let normalized = false;
  if (body.elements?.length) {
    const nameMap = await normalizeElementNames(body.elements).catch(() => ({}));
    if (Object.keys(nameMap).length) {
      body.elements = body.elements.map((el: any) => nameMap[el.id] ? { ...el, label: nameMap[el.id] } : el);
      normalized = true;
    }
  }

  // On non-draft deploy: resolve triggers for event nodes
  if (!draft && body.elements?.length) {
    try {
      const ctx: ProcessContext = {
        process_id: id,
        process_name: body.name,
        events: body.elements.filter((el: any) => el.type === "event").map((el: any) => ({ id: el.id, label: el.label })),
        functions: body.elements.filter((el: any) => el.type === "function").map((el: any) => ({ id: el.id, label: el.label })),
      };
      const { elements, needs_review } = await resolveTriggers(body.elements, ctx);
      body.elements = elements;
      if (needs_review) {
        (body as any).status = "needs_review";
      }
    } catch (e: any) {
      console.error(`[workflow-deploy] trigger resolve failed on update: ${e.message}`);
      return c.json({ error: `Trigger resolve failed (Haiku unavailable): ${e.message}` }, 503);
    }
  }

  const result = await updateWorkflow(id, body, { draft });
  if (result === null) return c.json({ error: "Workflow not found" }, 404);
  if (result.errors.length > 0) return c.json({ error: "Validation failed", details: result.errors }, 422);

  // Subscribe start events on successful non-draft deploy without needs_review
  if (!draft && !(result.workflow as any).status?.includes("needs_review")) {
    subscribeStartEvents(result.workflow).catch(e =>
      console.error(`[workflow-deploy] subscribeStartEvents update error: ${e.message}`),
    );
  }

  return c.json({ ...result.workflow, normalized });
});

router.delete("/:id{.+}", requireAuth, async (c) => {
  const id = c.req.param("id");
  const ok = await archiveWorkflow(id);
  if (!ok) return c.json({ error: "Workflow not found" }, 404);
  return c.json({ ok: true, archived: id });
});

// Load workflow definitions from disk into Redis on startup
const WORKFLOWS_DIR = process.env.KONOHA_WORKFLOWS_DIR || join(import.meta.dir, "..", "..", "workflows");
loadWorkflows(WORKFLOWS_DIR).then(({ loaded, errors }) => {
  console.log(`[workflow-loader] startup: ${loaded} loaded, ${errors} failed validation`);
}).catch((e) => {
  console.error("[workflow-loader] startup error:", e.message);
});

export default router;
