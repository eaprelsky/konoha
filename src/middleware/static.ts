import { Hono } from "hono";
import { join, extname } from "path";
import { existsSync, statSync, readFileSync } from "fs";

export const DIST_UI_DIR = join(import.meta.dir, "..", "..", "dist", "ui");
export const PUBLIC_DIR  = join(import.meta.dir, "..", "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

const router = new Hono();

router.get("/", (c) => c.redirect("/ui/index.html"));
router.get("/:file{.+}", (c) => {
  const name = c.req.param("file");
  if (name.includes("..")) return c.text("Forbidden", 403);
  const ext  = extname(name).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  // Prefer built React output; fall back to vanilla public/
  for (const base of [DIST_UI_DIR, PUBLIC_DIR]) {
    const filePath = join(base, name);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return c.body(readFileSync(filePath), 200, { "content-type": mime });
    }
  }
  return c.text("Not found", 404);
});

export default router;
