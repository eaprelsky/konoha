import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { executeActionDirect, type ActionExecution } from "../action-executor";

const router = new Hono();

function actionJson(c: any, result: ActionExecution): Response {
  return c.json(result.data as any, result.status as any);
}

router.get("/", async (c) => {
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
  const result = await executeActionDirect("role.list", {});
  return actionJson(c, result!);
});

router.post("/", requireAdmin, async (c) => {
  const body = await c.req.json();
  const { role_id, name, description, assignees = [], strategy = "manual" } = body;
  if (!role_id || !name) return c.json({ error: "role_id and name required" }, 400);
  const result = await executeActionDirect("role.create", { role_id, name, description, assignees, strategy });
  return actionJson(c, result!);
});

router.patch("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const result = await executeActionDirect("role.update", { id, ...body });
  return actionJson(c, result!);
});

router.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const result = await executeActionDirect("role.delete", { id });
  return actionJson(c, result!);
});

export default router;
