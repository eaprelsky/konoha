import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../../../../src/middleware/auth";
import {
  loadWorkflows,
  getWorkflow,
  listWorkflows,
  listWorkflowVersions,
  getWorkflowVersion,
} from "../../../../src/workflow-loader";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { executeWorkflowAction } from "../../../../src/action-executor";
import { listCases, type CaseStatus } from "../../../../src/runtime";

const router = new Hono();

router.get("/", requireAuth, async (c) => {
  const workflows = await listWorkflows();
  return c.json(workflows);
});

// NOTE: /versions sub-route must be declared BEFORE the wildcard get below
router.get("/:id{.+}/versions", requireAuth, async (c) => {
  const id = c.req.param("id")!;
  const versions = await listWorkflowVersions(id);
  return c.json(versions);
});

router.get("/:id{.+}/cases", requireAuth, async (c) => {
  const id = c.req.param("id")!;
  const wf = await getWorkflow(id);
  if (!wf) return c.json({ error: "Workflow not found" }, 404);
  const status = (c.req.query("status") || "running") as CaseStatus;
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 2000);
  const offset = parseInt(c.req.query("offset") || "0");
  const result = await listCases({ process_id: id, status, limit, offset });
  return c.json(result);
});

// :id{.+} captures slashes so IDs like "general/reflection" work correctly
router.get("/:id{.+}", requireAuth, async (c) => {
  const id = c.req.param("id")!;
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

router.post("/", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const draft = body.draft === true || c.req.query("draft") === "true";
  const result = await executeWorkflowAction("workflow.create", { ...body, draft }, { compatibilityDefaults: true });
  return c.json(result!.data as any, result!.status as any);
});

router.put("/:id{.+}", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const draft = body.draft === true || c.req.query("draft") === "true";
  const result = await executeWorkflowAction("workflow.update", { ...body, id, draft });
  return c.json(result!.data as any, result!.status as any);
});

router.delete("/:id{.+}", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const result = await executeWorkflowAction("workflow.delete", { id });
  return c.json(result!.data as any, result!.status as any);
});

// Load workflow definitions from disk into Redis on startup
const WORKFLOWS_DIR = process.env.KONOHA_WORKFLOWS_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "workflows");
loadWorkflows(WORKFLOWS_DIR).then(({ loaded, errors }) => {
  console.log(`[workflow-loader] startup: ${loaded} loaded, ${errors} failed validation`);
}).catch((e) => {
  console.error("[workflow-loader] startup error:", e.message);
});

export default router;
