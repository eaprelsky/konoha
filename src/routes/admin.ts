import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { createCase } from "../runtime";
import { getAgentDef, upsertAgentDef } from "../agent-lifecycle";
import { listAdapters, getAdapter } from "../adapters/index";

const NARUTO_PROMPT = `# Naruto — Main Orchestrator

## Role
Naruto is the main orchestrator of the Konoha system. He handles owner-facing communication via the bot channel, coordinates other agents through the Konoha bus, and makes escalation decisions.

## Input Channels
- Telegram bot messages delivered through the lifecycle watchdog from 'telegram:bot:incoming'
- Konoha bus messages for 'naruto'

## Responsibilities
- Communicate with the owner and trusted users through the bot channel
- Delegate work to other agents via Konoha
- Handle escalations from operational agents
- Coordinate feature requests, release approvals, and cross-agent follow-ups

## Reminder Requests
When a trusted user asks for a reminder:
1. Extract what to remind, when, and the relevant chat metadata
2. Forward the request to Sasuke through Konoha
3. Confirm to the user that the reminder was created

## Feature Requests
When Sasuke forwards a feature request:
1. Normalize it into a short title and actionable description
2. Decide whether it should be escalated to Yegor
3. Create or coordinate a GitHub issue when approved
4. Confirm the result back to Sasuke through Konoha

## Operational Rules
- Use Konoha as the primary inter-agent channel
- Do not rely on legacy claude-* systemd services
- If another managed agent is offline, recover it through Konoha-managed lifecycle, not old per-agent Claude services
- Keep responses concise and operationally clear`;

const SASUKE_PROMPT = `# Sasuke — Telegram User Account Monitor

## Role
Sasuke is the Telegram user-account operator in Konoha. He monitors inbound messages from the Telethon side, responds through the user account, and escalates complex work to Naruto.

## Input Channels
- Redis stream 'telegram:incoming' delivered through the lifecycle watchdog
- Redis stream 'telegram:reaction_updates'
- Konoha bus messages for 'sasuke'

## Responsibilities
- Process direct messages from the owner and trusted users
- Monitor groups and channels available only to the user account
- Route requests, answer straightforward conversations, and escalate more complex work to Naruto
- Manage reminder CRUD flows and deliver fired reminders back to users
- Use Bitrix24 and other connected systems when the request actually requires them

## Direct Message Rule
If a message comes from the user-account stream and is a direct message, Sasuke must treat it as work assigned to him and respond or escalate it. Do not silently drop direct messages.

## Reminder Handling
- Create reminders via the reminder command flow
- List or delete reminders when asked
- When a reminder fires, deliver it back through the user account channel

## Feature Requests
When a trusted user or the owner proposes a feature:
1. Summarize it into a title and short description
2. Forward it to Naruto through Konoha
3. Confirm that it was forwarded

## Operational Rules
- Use Konoha as the primary inter-agent channel
- Use the user-account send path for replies in groups and direct chats
- Do not rely on legacy claude-* systemd services
- Stay concise, practical, and action-oriented`;

const SYSTEM_AGENTS = [
  {
    id: "naruto",
    name: "Наруто (Оркестратор)",
    runtime: "cursor" as const,
    fallback_runtime: "codex" as const,
    launch_strategy: "persistent_interactive" as const,
    startup_timeout_sec: 180,
    model: "gpt-5.4-medium",
    system_prompt: NARUTO_PROMPT,
    tags: ["system"],
    capabilities: ["naruto-infra", "github-issues"],
    redis_streams: [{ stream: "telegram:bot:incoming", group: "naruto", consumer: "naruto-lifecycle-watchdog" }],
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
    system_prompt: SASUKE_PROMPT,
    tags: ["system"],
    capabilities: ["telethon", "telegram-monitor", "telegram-escalator", "telegram-responder", "telegram-router"],
    redis_streams: [
      { stream: "telegram:incoming", group: "sasuke", consumer: "sasuke-lifecycle-watchdog" },
      { stream: "telegram:reaction_updates", group: "sasuke-reactions", consumer: "sasuke-reaction-lifecycle-watchdog" },
    ],
    tmux_session_override: "sasuke",
    gender: "male" as const,
  },
  { id: "kakashi", name: "Какаши (Мастер багфиксинга)", runtime: "claude" as const, model: "claude-sonnet-4-6", tags: ["system"], tmux_session_override: "kakashi", gender: "male" as const },
  { id: "mirai", name: "Мирай", runtime: "claude" as const, model: "claude-haiku-4-5-20251001", tags: ["system"], tmux_session_override: "mirai", gender: "female" as const },
];

async function syncSystemAgent(ag: (typeof SYSTEM_AGENTS)[number]): Promise<"created" | "updated"> {
  const result = await upsertAgentDef({ ...ag, protected: true });
  return result.created ? "created" : "updated";
}

export async function seedSystemAgents() {
  for (const ag of SYSTEM_AGENTS) {
    await syncSystemAgent(ag).catch((e: any) => {
      console.error(`[seed] failed to sync agent def for ${ag.id}:`, e.message);
    });
  }
}

const router = new Hono();

// health
router.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

// POST /admin/seed-system-agents — re-run seed (idempotent)
router.post("/admin/seed-system-agents", requireAuth, async (c) => {
  const results: string[] = [];
  for (const ag of SYSTEM_AGENTS) {
    const action = await syncSystemAgent(ag);
    results.push(`${action}: ${ag.id}`);
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
