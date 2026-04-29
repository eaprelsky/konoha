import { Hono } from "hono";
import { writeFileSync } from "fs";
import { join, extname } from "path";
import { requireAuth } from "../middleware/auth";
import { getAgentDef, updateAgentDef } from "../agent-lifecycle";
import { generateAvatar, generateAvatarImg2Img } from "../adapters/image";

const AVATARS_DIR = "/opt/shared/avatars";

const router = new Hono();

router.post("/:id/avatar", requireAuth, async (c) => {
  const id = c.req.param("id")!;
  const def = await getAgentDef(id);
  if (!def) return c.json({ error: "Agent not found" }, 404);
  const contentType = c.req.header("content-type") || "";

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
        await updateAgentDef(id, { avatar_url: result.avatar_url });
        return c.json({ avatar_url: result.avatar_url });
      } catch (e: any) {
        return c.json({ error: e.message }, 500);
      }
    }

    // upload mode: file only
    const filename = `agent_${id.replace(/[^a-zA-Z0-9@.-]/g, "_")}_${Date.now()}${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(join(AVATARS_DIR, filename), buf);
    const avatar_url = `/api/avatars/${filename}`;
    await updateAgentDef(id, { avatar_url });
    return c.json({ avatar_url });
  }

  // text2img mode: JSON body
  const body = await c.req.json<{ style?: string; description?: string; prompt?: string }>().catch((): { style?: string; description?: string; prompt?: string } => ({}));
  try {
    const result = await generateAvatar({
      id,
      name: def.name,
      description: body.description || def.system_prompt?.slice(0, 100),
      style: body.style,
      prompt: body.prompt,
    });
    await updateAgentDef(id, { avatar_url: result.avatar_url });
    return c.json({ avatar_url: result.avatar_url });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default router;
