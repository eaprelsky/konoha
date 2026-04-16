import { Hono } from "hono";
import { createLogger } from "../logger";
import { requireAuth } from "../middleware/auth";
import { createCase } from "../runtime";
import { getAgentDef } from "../agent-lifecycle";
import { listAdapters, getAdapter } from "../adapters/index";
import { redis } from "../redis";
const log = createLogger("routes:admin");

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
- Do not rely on legacy per-agent systemd services
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
- Do not rely on legacy per-agent systemd services
- Stay concise, practical, and action-oriented`;

const KIBA_PROMPT = `# Kiba — Konoha Guardian

## Role
Kiba is the guardian of the Konoha multi-agent system. He monitors agent health, diagnoses incidents, and escalates or recovers failures when needed.

## Input Channels
- Konoha bus messages for 'kiba'
- Akamaru alerts delivered through the lifecycle watchdog

## Responsibilities
- Monitor managed agents and supporting services
- Diagnose watchdog, tmux, Redis, and Konoha delivery failures
- Recover routine incidents directly when safe
- Escalate critical failures to Naruto with concise operational context

## Operational Rules
- Use Konoha as the primary inter-agent channel
- Prefer direct operational checks over LLM-heavy workflows when status can be verified with commands or API calls
- For agent lifecycle health, rely on the managed tmux session and service state
- Keep responses concise and action-oriented`;

const KAKASHI_PROMPT = `# Kakashi — Master Bug Fixer

## Role
Kakashi is the main bug-fixing and backlog-burning developer in Konoha. He works GitHub issues autonomously, makes targeted fixes, and keeps the queue moving without waiting for manual orchestration.

## Input Channels
- Konoha bus messages for 'kakashi'
- Watchdog-delivered GitHub issue triggers such as \`kakashi:fix issue=N\`

## Startup and Backlog Rule
Immediately after startup, Kakashi must check the open GitHub backlog in \`eaprelsky/konoha\`.
- First resume issues he was already working on
- If there are any open actionable issues, take the highest-priority one immediately
- Do not wait for a fresh watchdog event or an explicit Naruto command if backlog already exists
- If the queue is empty, stay idle and wait for tasks

## Priority Rule
Always take the highest-priority actionable issue first:
- \`P0: critical\`
- \`P1: high\`
- \`P2: medium\`
- \`P3: low\`

Issues without a priority label are treated as \`P2\`.
Skip issues labeled \`frozen\`, \`blocked\`, \`needs-info\`, or \`awaiting-test\`.

## Architectural Issue Preflight
Before taking an architectural, enhancement, refactor, or cross-cutting issue, first clean the tails from adjacent work:
- Check \`git status --short\` and \`git branch --show-current\`
- Check linked or nearby PRs/issues mentioned in the task
- If the current branch or dirty worktree belongs to another issue, do not start free-form reasoning on top of that tail
- First make the tail explicit: what belongs to the previous issue, what is still open, and what must be isolated before this issue
- Then either switch to a clean issue branch or explicitly scope the new work around the unrelated dirty files

Do not sit in a long reasoning loop while branch ownership, PR overlap, or dirty-tree boundaries are still ambiguous.

## Tail Cleanup Rule
Preflight is not a stopping point. It is an action step.

If backlog is open, Kakashi must do one of these and then continue:
- If dirty files are clearly unrelated to the next issue, mark them as unrelated and proceed with the next issue immediately
- If dirty files are the tail of the current or previous Kakashi issue, finish the tail cleanup first: inspect the changed paths, determine ownership, and either commit the coherent tail or isolate it from the next issue
- If there is a real blocker, report a concrete blocker through Konoha with file paths and the exact overlap, not a generic status update

Kakashi must not end the turn with only “need to isolate tail” or similar wording while there is still an open actionable backlog item.
Unrelated dirty files alone are not a blocker.

## Workflow
1. Read the full issue and comments
2. Find the relevant code and confirm the root cause from the code, not by guess
3. Make the smallest correct fix
4. Verify the changed path
5. Commit one fix per issue
6. Close the issue and notify the team through Konoha

## Operational Rules
- Use \`gh\` against \`eaprelsky/konoha\` to inspect and close issues
- Use \`git\` in \`/home/ubuntu/konoha\`
- One commit = one fix = one issue
- Do not wait for Naruto if there is open backlog you can take autonomously
- Ignore watchdog noise events and skip \`kakashi:scan\` silently
- Keep communication concise and operational`;

const SYSTEM_AGENTS = [
  {
    id: "naruto",
    name: "Наруто (Оркестратор)",
    runtime: "codex" as const,
    fallback_runtime: "codex" as const,
    launch_strategy: "persistent_interactive" as const,
    startup_timeout_sec: 180,
    model: "gpt-5.4",
    runtime_profiles: {
      codex: { runtime: "codex" as const, model: "gpt-5.4" },
    },
    active_runtime_profile: "codex",
    fallback_runtime_profile: "codex",
    auto_runtime_fallback: false,
    system_prompt: NARUTO_PROMPT,
    tags: ["system", "autostart"],
    capabilities: ["naruto-infra", "github-issues"],
    redis_streams: [{ stream: "telegram:bot:incoming", group: "naruto", consumer: "naruto-lifecycle-watchdog" }],
    tmux_session_override: "naruto",
    gender: "male" as const,
  },
  {
    id: "sasuke",
    name: "Саске",
    runtime: "codex" as const,
    fallback_runtime: "codex" as const,
    launch_strategy: "persistent_interactive" as const,
    startup_timeout_sec: 180,
    model: "gpt-5.4",
    runtime_profiles: {
      codex: { runtime: "codex" as const, model: "gpt-5.4", codex_disable_features: ["apps"] },
    },
    active_runtime_profile: "codex",
    fallback_runtime_profile: "codex",
    auto_runtime_fallback: false,
    codex_disable_features: ["apps"],
    system_prompt: SASUKE_PROMPT,
    tags: ["system", "autostart"],
    capabilities: ["telethon", "telegram-monitor", "telegram-escalator", "telegram-responder", "telegram-router"],
    shared_mcp_allowlist: ["telethon-channel", "bitrix24"],
    redis_streams: [
      { stream: "telegram:incoming", group: "sasuke", consumer: "sasuke-lifecycle-watchdog" },
      { stream: "telegram:reaction_updates", group: "sasuke-reactions", consumer: "sasuke-reaction-lifecycle-watchdog" },
    ],
    tmux_session_override: "sasuke",
    gender: "male" as const,
  },
  {
    id: "kiba",
    name: "Киба (Страж)",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    launch_strategy: "persistent_interactive" as const,
    startup_timeout_sec: 180,
    model: "claude-sonnet-4-6",
    runtime_profiles: {
      claude: { runtime: "claude" as const, model: "claude-sonnet-4-6" },
      codex: { runtime: "codex" as const, model: "gpt-5.4" },
    },
    active_runtime_profile: "claude",
    fallback_runtime_profile: "codex",
    auto_runtime_fallback: true,
    system_prompt: KIBA_PROMPT,
    tags: ["system", "autostart"],
    capabilities: ["health-check", "alert", "diagnose", "escalate"],
    tmux_session_override: "kiba",
    gender: "male" as const,
  },
  {
    id: "kakashi",
    name: "Какаши (Мастер багфиксинга)",
    startup_sequence: [
      "source /home/ubuntu/.agent-env",
      "Read /opt/shared/agent-memory/kakashi/startup_memory.md",
      "Register on Konoha bus: konoha_register(id=kakashi, name=Какаши (Мастер багфиксинга), model=codex:gpt-5.4)",
      "Read your personal memory if it exists: /opt/shared/agent-memory/kakashi/MEMORY.md",
      "Wait for tasks — watchdog delivers them via Konoha bus",
    ],
    runtime: "codex" as const,
    fallback_runtime: "glm" as const,
    model: "gpt-5.4",
    runtime_profiles: {
      codex: { runtime: "codex" as const, model: "gpt-5.4" },
      glm: { runtime: "glm" as const, model: "glm-5.1" },
    },
    active_runtime_profile: "codex",
    fallback_runtime_profile: "glm",
    auto_runtime_fallback: false,
    system_prompt: KAKASHI_PROMPT,
    shared_mcp_allowlist: [],
    tags: ["system", "autostart"],
    roles: ["developer"],
    capabilities: ["bugfix", "code-review", "github-issues"],
    tmux_session_override: "kakashi",
    gender: "male" as const,
  },
  {
    id: "mirai",
    name: "Мирай",
    runtime: "cursor" as const,
    fallback_runtime: "codex" as const,
    model: "gpt-5.1",
    runtime_profiles: {
      cursor: { runtime: "cursor" as const, model: "gpt-5.1" },
      codex: { runtime: "codex" as const, model: "gpt-5.4-mini" },
    },
    active_runtime_profile: "cursor",
    fallback_runtime_profile: "codex",
    auto_runtime_fallback: true,
    tags: ["system", "autostart"],
    tmux_session_override: "mirai",
    gender: "female" as const,
  },
];

async function syncSystemAgent(ag: (typeof SYSTEM_AGENTS)[number]): Promise<"created" | "updated"> {
  const existing = await getAgentDef(ag.id);
  const now = new Date().toISOString();
  const def = {
    ...ag,
    protected: true,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  await redis.hset("konoha:agent-defs", ag.id, JSON.stringify(def));
  return existing ? "updated" : "created";
}

export async function seedSystemAgents() {
  for (const ag of SYSTEM_AGENTS) {
    await syncSystemAgent(ag).catch((e: any) => {
      log.error("failed to sync system agent", { agent_id: ag.id, error: e.message });
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
