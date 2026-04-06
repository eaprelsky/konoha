import { Hono } from "hono";
import { createDoc, listDocs, updateDoc, deleteDoc, type DocType } from "../runtime";

const router = new Hono();

router.get("/", async (c) => {
  return c.json(await listDocs());
});

router.post("/", async (c) => {
  const body = await c.req.json();
  const { name, type = "template", content = "" } = body;
  if (!name) return c.json({ error: "name required" }, 400);
  return c.json(await createDoc({ name, type: type as DocType, content }), 201);
});

router.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await updateDoc(id, body)); }
  catch (e: any) { return c.json({ error: e.message }, 404); }
});

router.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try { await deleteDoc(id); return c.json({ ok: true }); }
  catch (e: any) { return c.json({ error: e.message }, 404); }
});

export default router;
