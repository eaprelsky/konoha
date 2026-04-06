import { Hono } from "hono";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join, extname } from "path";
import { requireAuth } from "../middleware/auth";

export const AVATARS_DIR = "/opt/shared/avatars";
export const WORKSPACE_DIR = "/opt/shared/workspace";
const WORKSPACE_ALLOWED_EXT = new Set([".docx", ".xlsx", ".pdf", ".png", ".jpg", ".jpeg", ".wav", ".mp3", ".m4a", ".ogg"]);

if (!existsSync(WORKSPACE_DIR)) {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
}
if (!existsSync(AVATARS_DIR)) {
  mkdirSync(AVATARS_DIR, { recursive: true });
}

const router = new Hono();

// Serve uploaded avatars (public, no auth)
router.get("/avatars/:filename", (c) => {
  const filename = c.req.param("filename");
  if (filename.includes("..") || filename.includes("/")) return c.text("Forbidden", 403);
  const ext = extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
  const mime = mimeMap[ext] || "application/octet-stream";
  const filePath = join(AVATARS_DIR, filename);
  if (!existsSync(filePath)) return c.text("Not found", 404);
  return c.body(readFileSync(filePath), 200, { "content-type": mime, "cache-control": "public, max-age=86400" });
});

// Workspace routes (auth required)
router.use("/workspace", requireAuth);
router.use("/workspace/*", requireAuth);

router.get("/workspace/files", async (c) => {
  const files = readdirSync(WORKSPACE_DIR).map(name => {
    const fullPath = join(WORKSPACE_DIR, name);
    const st = statSync(fullPath);
    return { name, size: st.size, modified_at: st.mtime.toISOString() };
  });
  return c.json(files);
});

router.post("/workspace/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "file required" }, 400);
  const ext = extname(file.name).toLowerCase();
  if (!WORKSPACE_ALLOWED_EXT.has(ext)) {
    return c.json({ error: `File type not allowed: ${ext}` }, 415);
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const destPath = join(WORKSPACE_DIR, safeName);
  const buf = Buffer.from(await file.arrayBuffer());
  writeFileSync(destPath, buf);
  return c.json({ name: safeName, size: buf.length }, 201);
});

router.delete("/workspace/files/:name", async (c) => {
  const name = c.req.param("name");
  if (name.includes("/") || name.includes("..")) return c.json({ error: "Invalid file name" }, 400);
  const filePath = join(WORKSPACE_DIR, name);
  if (!existsSync(filePath)) return c.json({ error: "Not found" }, 404);
  unlinkSync(filePath);
  return c.json({ ok: true });
});

export default router;
