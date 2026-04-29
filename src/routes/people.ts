import { Hono } from "hono";
import { writeFileSync } from "fs";
import { join, extname } from "path";
import { requireAdmin } from "../middleware/auth";
import { auditLog } from "../assistant-actions";
import { generateAvatar, generateAvatarImg2Img } from "../adapters/image";
import { deleteCustomPerson, getPerson, listPeople, savePersonAvatar, upsertCustomPerson, type PersonRecord } from "../people-service";
import { errorResponse } from "../errors";

const AVATARS_DIR = "/opt/shared/avatars";

const router = new Hono();

function auditBase(c: any, sessionPrefix: string) {
  const caller: { isAdmin: boolean; agentId: string | null } = c.get("caller");
  return {
    timestamp: new Date().toISOString(),
    session_id: c.req.header("x-request-id") ?? `${sessionPrefix}:${Date.now()}`,
    agent_chain: caller.isAdmin ? "admin->api" : `${caller.agentId ?? "unknown"}->api`,
  };
}

router.get("/", async (c) => {
  return c.json(await listPeople());
});

router.post("/", requireAdmin, async (c) => {
  try {
    const record = await upsertCustomPerson(await c.req.json<Partial<PersonRecord>>());
    await auditLog({
      ...auditBase(c, "people"),
      action_type: "person.upsert",
      parameters: JSON.stringify({ id: record.id, source: "custom" }),
      result: "ok",
    });
    return c.json(record, 201);
  } catch (e) {
    const { status, body } = errorResponse(e);
    return c.json(body, status as any);
  }
});

router.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  try {
    const result = await deleteCustomPerson(id);
    await auditLog({
      ...auditBase(c, "people"),
      action_type: "person.delete",
      parameters: JSON.stringify({ id }),
      result: "ok",
    });
    return c.json(result);
  } catch (e) {
    const { status, body } = errorResponse(e);
    return c.json(body, status as any);
  }
});

router.post("/:id/avatar", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const contentType = c.req.header("content-type") || "";

  const person = await getPerson(id);
  if (!person) return c.json({ error: "Person not found" }, 404);

  async function savePeopleAvatar(avatar_url: string) {
    const saved = await savePersonAvatar(id, avatar_url);
    await auditLog({
      ...auditBase(c, "people-avatar"),
      action_type: "people.avatar.update",
      parameters: JSON.stringify({ id, file_based: saved.file_based }),
      result: "ok",
    });
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: "file required" }, 400);
    const ext = extname(file.name).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      return c.json({ error: "Only jpg/png/gif/webp allowed" }, 415);
    }

    const prompt = formData.get("prompt") as string | null;
    if (prompt) {
      // img2img mode: file + prompt → Replicate flux-kontext-pro
      try {
        const buf = Buffer.from(await file.arrayBuffer());
        const mime = file.type || "image/jpeg";
        const imageBase64 = `data:${mime};base64,${buf.toString("base64")}`;
        const result = await generateAvatarImg2Img({ id, imageBase64, prompt });
        await savePeopleAvatar(result.avatar_url);
        return c.json({ avatar_url: result.avatar_url });
      } catch (e: any) {
        return c.json({ error: e.message }, 500);
      }
    }

    // upload mode: file only
    const filename = `${id.replace(/[^a-zA-Z0-9@.-]/g, "_")}_${Date.now()}${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(join(AVATARS_DIR, filename), buf);
    const avatar_url = `/api/avatars/${filename}`;
    await savePeopleAvatar(avatar_url);
    return c.json({ avatar_url });
  }

  // text2img mode: JSON body
  const body = await c.req.json<{ style?: string; description?: string; prompt?: string }>().catch((): { style?: string; description?: string; prompt?: string } => ({}));
  try {
    const result = await generateAvatar({
      id,
      name: person.name,
      description: body.description || person.position,
      style: body.style,
      prompt: body.prompt,
    });
    await savePeopleAvatar(result.avatar_url);
    return c.json({ avatar_url: result.avatar_url });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default router;
