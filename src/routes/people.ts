import { Hono } from "hono";
import { writeFileSync } from "fs";
import { join, extname } from "path";
import { loadTrustedPeople } from "../people-directory";
import { requireAdmin } from "../middleware/auth";
import { redis } from "../redis";
import { auditLog } from "../assistant-actions";
import { generateAvatar, generateAvatarImg2Img } from "../adapters/image";

const PEOPLE_CUSTOM_KEY = "people:custom";
const PEOPLE_AVATARS_KEY = "people:avatars";
const AVATARS_DIR = "/opt/shared/avatars";

type PersonRecord = {
  id: string; name: string; tg_id: number; position: string;
  tg_username?: string; email?: string; source?: "file" | "custom";
  bitrix24_id?: string; tracker_login?: string; yonote_id?: string;
  channel?: "telegram" | "email";
  capabilities?: string[];
  avatar_url?: string;
};

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
  const trusted = loadTrustedPeople();
  const map = new Map<string, PersonRecord>(
    trusted
      .filter((p): p is PersonRecord & { id: string } => typeof p.id === "string" && p.id.length > 0)
      .map(p => [p.id, p]),
  );
  try {
    const custom = await redis.hgetall(PEOPLE_CUSTOM_KEY);
    for (const val of Object.values(custom)) {
      const p: PersonRecord = JSON.parse(val);
      map.set(p.id, { ...p, source: "custom" });
    }
    // Merge avatars for file-based people
    const avatars = await redis.hgetall(PEOPLE_AVATARS_KEY);
    for (const [id, avatar_url] of Object.entries(avatars)) {
      const existing = map.get(id);
      if (existing && !existing.avatar_url) {
        map.set(id, { ...existing, avatar_url });
      }
    }
  } catch { /* redis unavailable — serve trusted only */ }
  return c.json([...map.values()]);
});

router.post("/", requireAdmin, async (c) => {
  const body = await c.req.json<Partial<PersonRecord>>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = body.id?.trim() || body.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9@.-]/g, "");
  const trusted = loadTrustedPeople();
  if (trusted.some(p => p.id === id)) {
    return c.json({ error: "Cannot override file-based users" }, 409);
  }
  const record: PersonRecord = {
    id,
    name: body.name.trim(),
    tg_id: body.tg_id ?? 0,
    position: body.position?.trim() || "",
    tg_username: body.tg_username?.trim() || undefined,
    email: body.email?.trim() || undefined,
    source: "custom",
    bitrix24_id: body.bitrix24_id?.trim() || undefined,
    tracker_login: body.tracker_login?.trim() || undefined,
    yonote_id: body.yonote_id?.trim() || undefined,
    channel: (body.channel === "telegram" || body.channel === "email") ? body.channel : undefined,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities : undefined,
  };
  await redis.hset(PEOPLE_CUSTOM_KEY, id, JSON.stringify(record));
  await auditLog({
    ...auditBase(c, "people"),
    action_type: "people.upsert",
    parameters: JSON.stringify({ id, source: "custom" }),
    result: "ok",
  });
  return c.json(record, 201);
});

router.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const trusted = loadTrustedPeople();
  if (trusted.some(p => p.id === id)) {
    return c.json({ error: "Cannot delete file-based users" }, 403);
  }
  const deleted = await redis.hdel(PEOPLE_CUSTOM_KEY, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  await auditLog({
    ...auditBase(c, "people"),
    action_type: "people.delete",
    parameters: JSON.stringify({ id }),
    result: "ok",
  });
  return c.json({ ok: true });
});

router.post("/:id/avatar", requireAdmin, async (c) => {
  const id = c.req.param("id")!;
  const contentType = c.req.header("content-type") || "";

  // Resolve person (custom or file-based)
  const rawCustom = await redis.hget(PEOPLE_CUSTOM_KEY, id).catch(() => null);
  const trustedPeople = loadTrustedPeople();
  const trustedPerson = trustedPeople.find(p => p.id === id);
  const person: PersonRecord | null = rawCustom ? JSON.parse(rawCustom) : (trustedPerson || null);
  if (!person) return c.json({ error: "Person not found" }, 404);
  const isFileBased = !rawCustom;

  async function savePeopleAvatar(avatar_url: string) {
    if (isFileBased) {
      await redis.hset(PEOPLE_AVATARS_KEY, id, avatar_url);
    } else {
      (person as PersonRecord).avatar_url = avatar_url;
      await redis.hset(PEOPLE_CUSTOM_KEY, id, JSON.stringify(person));
    }
    await auditLog({
      ...auditBase(c, "people-avatar"),
      action_type: "people.avatar.update",
      parameters: JSON.stringify({ id, file_based: isFileBased }),
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
