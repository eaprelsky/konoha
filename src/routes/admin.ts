import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { createCase } from "../runtime";
import { createAgentDef, getAgentDef } from "../agent-lifecycle";
import { listAdapters, getAdapter } from "../adapters/index";

const SYSTEM_AGENTS = [
  {
    id: "naruto",
    name: "Наруто (Оркестратор)",
    runtime: "cursor" as const,
    fallback_runtime: "codex" as const,
    launch_strategy: "persistent_interactive" as const,
    startup_timeout_sec: 180,
    model: "gpt-5.4-medium",
    tags: ["system"],
    tmux_session_override: "naruto",
    gender: "male" as const,
  },
  {
    id: "sasuke",
    name: "Саске",
    runtime: "cursor" as const,
    fallback_runtime: "codex" as const,
    launch_strategy: "persistent_interactive" as const,
    startup_timeout_sec: 180,
    model: "gpt-5.1",
    tags: ["system"],
    tmux_session_override: "sasuke",
    gender: "male" as const,
  },
  { id: "kakashi", name: "Какаши (Мастер багфиксинга)", runtime: "claude" as const, model: "claude-sonnet-4-6", tags: ["system"], tmux_session_override: "kakashi", gender: "male" as const },
  { id: "mirai", name: "Мирай", runtime: "claude" as const, model: "claude-haiku-4-5-20251001", tags: ["system"], tmux_session_override: "mirai", gender: "female" as const },
];

export async function seedSystemAgents() {
  for (const ag of SYSTEM_AGENTS) {
    const existing = await getAgentDef(ag.id).catch(() => null);
    if (!existing) {
      await createAgentDef({ ...ag, protected: true }).catch((e: any) => {
        console.error(`[seed] failed to create agent def for ${ag.id}:`, e.message);
      });
      console.log(`[seed] created system AgentDef: ${ag.id}`);
    }
  }
}

const router = new Hono();

// health
router.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

// POST /admin/seed-system-agents — re-run seed (idempotent)
router.post("/admin/seed-system-agents", requireAuth, async (c) => {
  const results: string[] = [];
  for (const ag of SYSTEM_AGENTS) {
    const existing = await getAgentDef(ag.id).catch(() => null);
    if (!existing) {
      await createAgentDef({ ...ag, protected: true });
      results.push(`created: ${ag.id}`);
    } else {
      results.push(`exists: ${ag.id}`);
    }
  }
  return c.json({ ok: true, results });
});

// Webhook Trigger — public endpoint (protected by unpredictable process_id)
// POST /trigger/:process_id?subject=...  → creates a case and returns case_id
router.post("/trigger/:process_id{.+}", async (c) => {
  const process_id = c.req.param("process_id");
  const body = await c.req.json().catch(() => ({}));
  const subject = (body.subject as string) || c.req.query("subject") || `webhook-${Date.now()}`;
  const payload = (body.payload && typeof body.payload === "object") ? body.payload : body;
  try {
    const kase = await createCase(process_id, subject, payload);
    return c.json({ case_id: kase.case_id, status: kase.status }, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// Adapters
router.get("/adapters", async (c) => {
  return c.json({ adapters: listAdapters() });
});

router.get("/adapters/:name/health", async (c) => {
  const name = c.req.param("name");
  const adapter = getAdapter(name);
  if (!adapter) return c.json({ error: "Adapter not found" }, 404);
  const healthy = await adapter.healthcheck().catch(() => false);
  return c.json({ adapter: name, healthy }, healthy ? 200 : 503);
});

export default router;
