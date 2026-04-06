import { Hono } from "hono";
import { createRole, listRoles, updateRole, deleteRole, type AssignmentStrategy } from "../runtime";

const router = new Hono();

router.get("/", async (c) => {
  c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
  return c.json(await listRoles());
});

router.post("/", async (c) => {
  const body = await c.req.json();
  const { role_id, name, description, assignees = [], strategy = "manual" } = body;
  if (!role_id || !name) return c.json({ error: "role_id and name required" }, 400);
  const r = await createRole({ role_id, name, description, assignees, strategy: strategy as AssignmentStrategy });
  return c.json(r, 201);
});

router.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await updateRole(id, body)); }
  catch (e: any) { return c.json({ error: e.message }, 404); }
});

router.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try { await deleteRole(id); return c.json({ ok: true }); }
  catch (e: any) { return c.json({ error: e.message }, 404); }
});

export default router;
