import { Hono } from "hono";
import { redis } from "../redis";
import { pgUpsertSkill, pgDeleteSkill } from "../storage/pg";

const SKILL_KEY_PREFIX = "konoha:skill:";
const SKILLS_IDX_ALL   = "konoha:skills:all";

type McpServerDef = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type SkillRecord = {
  id: string; name: string; name_en?: string; description?: string;
  prompt_snippet?: string; tools?: string[]; mcp_servers?: McpServerDef[];
  created_at: string; updated_at: string;
};

const router = new Hono();

router.get("/", async (c) => {
  c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
  const ids = await redis.zrange(SKILLS_IDX_ALL, 0, -1);
  const raws = await Promise.all(ids.map(id => redis.get(SKILL_KEY_PREFIX + id)));
  return c.json(raws.filter(Boolean).map(r => JSON.parse(r!)));
});

router.post("/", async (c) => {
  const body = await c.req.json<Partial<SkillRecord>>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  const id = body.id?.trim() || body.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const now = new Date().toISOString();
  const skill: SkillRecord = {
    id, name: body.name.trim(),
    name_en: body.name_en?.trim() || undefined,
    description: body.description?.trim() || undefined,
    prompt_snippet: body.prompt_snippet?.trim() || undefined,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    mcp_servers: Array.isArray(body.mcp_servers) ? body.mcp_servers : undefined,
    created_at: now, updated_at: now,
  };
  await redis.set(SKILL_KEY_PREFIX + id, JSON.stringify(skill));
  await redis.zadd(SKILLS_IDX_ALL, new Date(now).getTime(), id);
  pgUpsertSkill(skill as any);
  return c.json(skill, 201);
});

router.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const raw = await redis.get(SKILL_KEY_PREFIX + id);
  if (!raw) return c.json({ error: "Skill not found" }, 404);
  const skill: SkillRecord = JSON.parse(raw);
  const body = await c.req.json<Partial<SkillRecord>>().catch(() => ({}));
  if (body.name !== undefined)           skill.name = body.name.trim();
  if (body.name_en !== undefined)        skill.name_en = body.name_en?.trim() || undefined;
  if (body.description !== undefined)    skill.description = body.description?.trim() || undefined;
  if (body.prompt_snippet !== undefined) skill.prompt_snippet = body.prompt_snippet?.trim() || undefined;
  if (body.tools !== undefined)          skill.tools = Array.isArray(body.tools) ? body.tools : undefined;
  if (body.mcp_servers !== undefined)    skill.mcp_servers = Array.isArray(body.mcp_servers) ? body.mcp_servers : undefined;
  skill.updated_at = new Date().toISOString();
  await redis.set(SKILL_KEY_PREFIX + id, JSON.stringify(skill));
  pgUpsertSkill(skill as any);
  return c.json(skill);
});

router.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await redis.del(SKILL_KEY_PREFIX + id);
  await redis.zrem(SKILLS_IDX_ALL, id);
  pgDeleteSkill(id);
  return c.json({ ok: true });
});

export default router;
