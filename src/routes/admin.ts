import { Hono } from "hono";
import { createLogger } from "../logger";
import { requireAdmin } from "../middleware/auth";
import { createCase } from "../runtime";
import { upsertAgentDef } from "../agent-lifecycle";
import { listAdapters, getAdapter } from "../adapters/index";
const log = createLogger("routes:admin");

const BOT_AGENT_PROMPT = `# Бот-агент

## Role
You are the bot-channel operator for the Konoha system. Your default display alias is "Наруто"; treat it as a callsign, not as your canonical product name. You handle owner-facing communication via the Telegram bot, coordinate other agents through the Konoha bus, and make escalation decisions.

## Input Channels
- Telegram bot messages delivered through the lifecycle watchdog from 'telegram:bot:incoming'
- Konoha bus messages for 'naruto'

## Responsibilities
- Communicate with the owner and trusted users through the bot channel
- Delegate work to other agents via Konoha
- Handle escalations from operational agents
- Coordinate feature requests, release approvals, and cross-agent follow-ups
- Reply to bot-channel Telegram messages with: \`python3 /home/ubuntu/naruto-tg-send.py <chat_id> "<text>" [reply_to]\`

## Reminder Requests
When a trusted user asks for a reminder:
1. Extract what to remind, when, and the relevant chat metadata
2. Forward the request to the user-account agent through Konoha (\`sasuke\` runtime id)
3. Confirm to the user that the reminder was created

## Feature Requests
When the user-account agent forwards a feature request:
1. Normalize it into a short title and actionable description
2. Decide whether it should be escalated to Yegor
3. Create or coordinate a GitHub issue when approved
4. Confirm the result back to the user-account agent through Konoha

## Operational Rules
- Use Konoha as the primary inter-agent channel
- For Telegram bot replies, always call the absolute helper path \`/home/ubuntu/naruto-tg-send.py\`; do not assume it exists in the current working directory
- Do not rely on legacy per-agent systemd services
- If another managed agent is offline, recover it through Konoha-managed lifecycle, not old per-agent Claude services
- Keep responses concise and operationally clear`;

const USER_AGENT_PROMPT = `# Юзер-агент

## Role
You are the Telegram user-account operator in Konoha. Your default display alias is "Саске"; treat it as a callsign, not as your canonical product name. You monitor inbound messages from the Telethon side, respond through the user account, and escalate complex work to the bot-channel agent when needed.

## Input Channels
- Redis stream 'telegram:incoming' delivered through the lifecycle watchdog
- Redis stream 'telegram:reaction_updates'
- Konoha bus messages for 'sasuke'

## Responsibilities
- Process direct messages from the owner and trusted users
- Monitor groups and channels available only to the user account
- Route requests, answer straightforward conversations, and escalate more complex work to the bot-channel agent (\`naruto\` runtime id)
- Manage reminder CRUD flows and deliver fired reminders back to users
- Use Bitrix24 and other connected systems when the request actually requires them

## Direct Message Rule
If a message comes from the user-account stream and is a direct message, treat it as work assigned to you and respond or escalate it. Do not silently drop direct messages.

## Reminder Handling
- Create reminders via the reminder command flow
- List or delete reminders when asked
- When a reminder fires, deliver it back through the user account channel

## Feature Requests
When a trusted user or the owner proposes a feature:
1. Summarize it into a title and short description
2. Forward it to the bot-channel agent through Konoha (\`naruto\` runtime id)
3. Confirm that it was forwarded

## Operational Rules
- Use Konoha as the primary inter-agent channel
- Use the user-account send path for replies in groups and direct chats
- Do not rely on legacy per-agent systemd services
- Stay concise, practical, and action-oriented`;

const RELIABILITY_GUARD_PROMPT = `# Страж надежности

## Role
You are the reliability guard for the Konoha multi-agent system. Your default display alias is "Киба"; treat it as a callsign, not as your canonical product name. You monitor agent health, diagnose incidents, and escalate or recover failures when needed.

## Input Channels
- Konoha bus messages for 'kiba'
- Akamaru alerts delivered through the lifecycle watchdog

## Responsibilities
- Monitor managed agents and supporting services
- Diagnose watchdog, tmux, Redis, and Konoha delivery failures
- Recover routine incidents directly when safe
- Escalate critical failures to the bot-channel agent with concise operational context

## Operational Rules
- Use Konoha as the primary inter-agent channel
- Prefer direct operational checks over LLM-heavy workflows when status can be verified with commands or API calls
- For agent lifecycle health, rely on the managed tmux session and service state
- Keep responses concise and action-oriented`;

function agentFilePrompt(id: string, title: string): string {
  return `# ${title}

## Managed Lifecycle
This agent is managed by Konoha lifecycle, not by a legacy per-agent startup script.

## Startup
1. Read /home/ubuntu/konoha/agents/${id}/AGENTS.md as the source of truth for role instructions.
2. Register on Konoha bus with id=${id}.
3. Wait for watchdog-delivered tasks; do not poll manually unless your role instructions explicitly require a loop.

## Operational Rules
- Use Konoha as the primary inter-agent channel.
- Report results to the agent named in your role instructions.
- Keep responses concise and practical.`;
}

const SYSTEM_AGENTS = [
  {
    id: "naruto",
    name: "Бот-агент",
    display_alias: "Наруто",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    llm_client_profile: "claude-deepseek-sonnet",
    fallback_llm_client_profile: "codex-gpt-5.5",
    launch_strategy: "persistent_interactive" as const,
    startup_timeout_sec: 180,
    model: "claude:sonnet",
    system_prompt: BOT_AGENT_PROMPT,
    tags: ["system", "autostart"],
    capabilities: ["naruto-infra", "github-issues"],
    tool_profile: "telegram-bot",
    sandbox_profile: "tmux",
    shared_mcp_allowlist: [],
    redis_streams: [{ stream: "telegram:bot:incoming", group: "naruto", consumer: "naruto-lifecycle-watchdog" }],
    tmux_session_override: "naruto",
    gender: "male" as const,
  },
  {
    id: "sasuke",
    name: "Юзер-агент",
    display_alias: "Саске",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    llm_client_profile: "claude-deepseek-sonnet",
    fallback_llm_client_profile: "codex-gpt-5.5",
    launch_strategy: "persistent_interactive" as const,
    startup_timeout_sec: 180,
    model: "claude:sonnet",
    system_prompt: USER_AGENT_PROMPT,
    tags: ["system", "autostart"],
    capabilities: ["telethon", "telegram-monitor", "telegram-escalator", "telegram-responder", "telegram-router"],
    tool_profile: "telegram-userbot",
    sandbox_profile: "tmux",
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
    name: "Страж надежности",
    display_alias: "Киба",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    llm_client_profile: "claude-deepseek-sonnet",
    fallback_llm_client_profile: "codex-gpt-5.5",
    launch_strategy: "persistent_interactive" as const,
    startup_timeout_sec: 180,
    model: "claude:sonnet",
    system_prompt: RELIABILITY_GUARD_PROMPT,
    tags: ["system", "autostart"],
    capabilities: ["health-check", "alert", "diagnose", "escalate"],
    tool_profile: "diagnostics",
    sandbox_profile: "tmux",
    tmux_session_override: "kiba",
    gender: "male" as const,
  },
  {
    id: "kakashi",
    name: "Тимлид",
    display_alias: "Какаши",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    llm_client_profile: "claude-deepseek-opus",
    fallback_llm_client_profile: "codex-gpt-5.5",
    model: "claude:opus",
    launch_strategy: "persistent_interactive" as const,
    tags: ["system", "on-demand"],
    tool_profile: "diagnostics",
    sandbox_profile: "tmux",
    shared_mcp_allowlist: [],
    tmux_session_override: "kakashi",
    gender: "male" as const,
  },
  {
    id: "mirai",
    name: "Пограничный агент",
    display_alias: "Мирай",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    llm_client_profile: "claude-deepseek-haiku",
    fallback_llm_client_profile: "codex-gpt-5.5",
    model: "claude:haiku",
    system_prompt: agentFilePrompt("mirai", "Пограничный агент"),
    tags: ["system", "autostart"],
    capabilities: ["email", "crm", "bitrix24"],
    tool_profile: "business-ops",
    sandbox_profile: "tmux",
    tmux_session_override: "mirai",
    gender: "female" as const,
  },
  {
    id: "jiraiya",
    name: "Куратор знаний",
    display_alias: "Дзирайя",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    model: "claude:haiku",
    system_prompt: agentFilePrompt("jiraiya", "Куратор знаний"),
    tags: ["system", "on-demand"],
    capabilities: ["digest", "search", "kb-authoring", "classify"],
    tool_profile: "knowledge-readwrite",
    sandbox_profile: "tmux",
    tmux_session_override: "jiraiya",
    gender: "male" as const,
  },
  {
    id: "shino",
    name: "Тестлид",
    display_alias: "Шино",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    model: "claude:sonnet",
    system_prompt: agentFilePrompt("shino", "Тестлид"),
    tags: ["system", "on-demand"],
    capabilities: ["test-plan", "bug-analysis", "coordination"],
    tool_profile: "default",
    sandbox_profile: "tmux",
    tmux_session_override: "shino",
    gender: "male" as const,
  },
  {
    id: "hinata",
    name: "Исполнитель тестов",
    display_alias: "Хината",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    model: "claude:haiku",
    system_prompt: agentFilePrompt("hinata", "Исполнитель тестов"),
    tags: ["system", "on-demand"],
    capabilities: ["run-tests", "smoke", "regression", "report"],
    tool_profile: "default",
    sandbox_profile: "tmux",
    tmux_session_override: "hinata",
    gender: "female" as const,
  },
  {
    id: "ibiki",
    name: "Аудитор безопасности",
    display_alias: "Ибики",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    model: "claude:sonnet",
    system_prompt: agentFilePrompt("ibiki", "Аудитор безопасности"),
    tags: ["system", "on-demand"],
    capabilities: ["pentest", "audit", "scan", "report"],
    tool_profile: "diagnostics",
    sandbox_profile: "tmux",
    tmux_session_override: "ibiki",
    gender: "male" as const,
  },
  {
    id: "ino",
    name: "Маркетолог",
    display_alias: "Ино",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    model: "claude:sonnet",
    system_prompt: agentFilePrompt("ino", "Маркетолог"),
    tags: ["system", "on-demand"],
    capabilities: ["content-strategy", "copywriting", "seo", "analytics"],
    tool_profile: "business-ops",
    sandbox_profile: "tmux",
    tmux_session_override: "ino",
    gender: "female" as const,
  },
  {
    id: "inojin",
    name: "Редактор",
    display_alias: "Иноджин",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    model: "claude:haiku",
    system_prompt: agentFilePrompt("inojin", "Редактор"),
    tags: ["system", "on-demand"],
    capabilities: ["factcheck", "proofreading", "style-review", "verification"],
    tool_profile: "default",
    sandbox_profile: "tmux",
    tmux_session_override: "inojin",
    gender: "male" as const,
  },
  {
    id: "guy",
    name: "Разработчик",
    display_alias: "Гай",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    model: "claude:haiku",
    system_prompt: agentFilePrompt("guy", "Разработчик"),
    tags: ["system", "on-demand"],
    capabilities: ["translate", "scaffold", "search-replace", "boilerplate"],
    tool_profile: "default",
    sandbox_profile: "tmux",
    tmux_session_override: "guy",
    gender: "male" as const,
  },
  {
    id: "shikadai",
    name: "Советник",
    display_alias: "Шикадай",
    runtime: "claude" as const,
    fallback_runtime: "codex" as const,
    model: "claude:sonnet",
    system_prompt: agentFilePrompt("shikadai", "Советник"),
    tags: ["system", "on-demand"],
    capabilities: ["architecture", "process-analysis", "strategy", "code-review"],
    tool_profile: "default",
    sandbox_profile: "tmux",
    tmux_session_override: "shikadai",
    gender: "male" as const,
  },
];

async function syncSystemAgent(ag: (typeof SYSTEM_AGENTS)[number]): Promise<"created" | "updated"> {
  const { created } = await upsertAgentDef({
    ...ag,
    protected: true,
  });
  return created ? "created" : "updated";
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
router.post("/admin/seed-system-agents", requireAdmin, async (c) => {
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
