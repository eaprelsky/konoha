export type McpNecessity =
  | "default-critical"
  | "role-scoped"
  | "optional-on-demand"
  | "retired";

export type McpCostBand =
  | "none"
  | "low"
  | "medium"
  | "heavy";

export interface McpCostCatalogEntry {
  server: string;
  necessity: McpNecessity;
  cost_band: McpCostBand;
  default_allowed_for_roles: string[];
  opt_in_only: boolean;
  retired: boolean;
  measurement: {
    sampled_at: string;
    source: string;
    idle_process_count: number;
    idle_rss_kib: number;
    idle_cpu_pct: number;
    note?: string;
  };
  notes: string;
}

export interface RoleDefaultMcpAllowlist {
  role: string;
  agent_ids: string[];
  mcp_servers: string[];
  notes: string;
}

export const MCP_COST_CATALOG_SAMPLE = {
  sampled_at: "2026-05-20T20:18:00+03:00",
  source: "ps -eo pid=,ppid=,rss=,pcpu=,comm=,args= on nocturna Konoha runtime",
} as const;

export const MCP_COST_CATALOG: readonly McpCostCatalogEntry[] = [
  {
    server: "konoha",
    necessity: "default-critical",
    cost_band: "medium",
    default_allowed_for_roles: ["all-managed-agents"],
    opt_in_only: false,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 1,
      idle_rss_kib: 80000,
      idle_cpu_pct: 0,
      note: "Per-agent Bun MCP process. Live duplicate cleanup reduced orphaned Konoha MCPs from 35 total/30 orphaned to 5 total/0 orphaned.",
    },
    notes: "Primary bus and action surface. Keep for Naruto, Sasuke, Kiba, SDD workers, and on-demand compatibility agents.",
  },
  {
    server: "telethon-channel",
    necessity: "default-critical",
    cost_band: "medium",
    default_allowed_for_roles: ["telegram-user-connector"],
    opt_in_only: false,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 1,
      idle_rss_kib: 89676,
      idle_cpu_pct: 0,
      note: "Sasuke required instance. One extra stale Kiba instance was observed and must disappear after Kiba MCP regeneration.",
    },
    notes: "Required for Sasuke user-account message flow; not required for Naruto bot flow.",
  },
  {
    server: "bitrix24",
    necessity: "role-scoped",
    cost_band: "medium",
    default_allowed_for_roles: ["telegram-user-connector", "external-source-connector"],
    opt_in_only: false,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 1,
      idle_rss_kib: 79592,
      idle_cpu_pct: 0,
      note: "Sasuke required instance. One extra stale Kiba instance was observed.",
    },
    notes: "Allowed only where CRM access is an always-on responsibility. Other roles use Konoha actions or explicit opt-in.",
  },
  {
    server: "gitlab",
    necessity: "optional-on-demand",
    cost_band: "heavy",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 3,
      idle_rss_kib: 109992,
      idle_cpu_pct: 0,
      note: "Observed only under stale Kiba broad MCP config.",
    },
    notes: "Repository operations should use local git/gh for developer tasks; GitLab MCP is not part of always-on defaults.",
  },
  {
    server: "yonote",
    necessity: "role-scoped",
    cost_band: "low",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 2,
      idle_rss_kib: 24156,
      idle_cpu_pct: 0,
      note: "Observed under stale Kiba broad MCP config; #775 keeps Sasuke default delta at 0 and allows bounded task/session attachment only.",
    },
    notes: "Narrow Sasuke knowledge lookup pack. Keep out of always-on defaults; attach only through corporate-memory task/session mode for read/search context.",
  },
  {
    server: "yonote-read",
    necessity: "role-scoped",
    cost_band: "low",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 2,
      idle_rss_kib: 24156,
      idle_cpu_pct: 0,
      note: "Same transport footprint as the sampled Yonote MCP, but with repo-owned read/search-only tool exposure for Sasuke task/session context.",
    },
    notes: "Sasuke-only bounded read/search context surface. Exposes no raw RPC, write, delete, export, admin, or attachment upload tools.",
  },
  {
    server: "yandex-tracker",
    necessity: "optional-on-demand",
    cost_band: "none",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 0,
      idle_rss_kib: 0,
      idle_cpu_pct: 0,
      note: "Configured in shared catalog but no live process was observed in the sample.",
    },
    notes: "Issue-tracker access is not required for active Naruto/Sasuke/Kiba/SDD runtime defaults.",
  },
  {
    server: "memory",
    necessity: "optional-on-demand",
    cost_band: "heavy",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 3,
      idle_rss_kib: 106656,
      idle_cpu_pct: 0,
      note: "Observed only under stale Kiba broad MCP config.",
    },
    notes: "Generic memory MCP duplicates Konoha/shared-memory workflows; do not load by default.",
  },
  {
    server: "mempalace",
    necessity: "retired",
    cost_band: "none",
    default_allowed_for_roles: [],
    opt_in_only: false,
    retired: true,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 0,
      idle_rss_kib: 0,
      idle_cpu_pct: 0,
      note: "Retired/removal candidate; no live process was observed.",
    },
    notes: "Retired from active Konoha runtime surface. Runtime skips it even if stale configs mention it.",
  },
  {
    server: "puppeteer",
    necessity: "optional-on-demand",
    cost_band: "heavy",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 3,
      idle_rss_kib: 105648,
      idle_cpu_pct: 0,
      note: "MCP server only; browser child processes add extra memory when a session opens pages.",
    },
    notes: "Direct browser MCP is a TTL debug pack. Default GUI checks use TestBench instead.",
  },
  {
    server: "sequential-thinking",
    necessity: "optional-on-demand",
    cost_band: "heavy",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 3,
      idle_rss_kib: 101256,
      idle_cpu_pct: 0,
      note: "Observed only under stale Kiba broad MCP config.",
    },
    notes: "Reasoning helper should be activated only for explicit analysis sessions, not always-on agents.",
  },
  {
    server: "caldav",
    necessity: "optional-on-demand",
    cost_band: "low",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 2,
      idle_rss_kib: 26744,
      idle_cpu_pct: 0,
      note: "Observed only under stale Kiba broad MCP config.",
    },
    notes: "Calendar operations are not part of default agent responsibilities.",
  },
  {
    server: "google-sheets",
    necessity: "optional-on-demand",
    cost_band: "none",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 0,
      idle_rss_kib: 0,
      idle_cpu_pct: 0,
      note: "No live process was observed; optional-pack gate keeps it out of broad defaults.",
    },
    notes: "Spreadsheet MCP belongs to explicit office/spreadsheet TTL sessions.",
  },
  {
    server: "google-docs",
    necessity: "optional-on-demand",
    cost_band: "none",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 0,
      idle_rss_kib: 0,
      idle_cpu_pct: 0,
      note: "No live process was observed; optional-pack gate keeps it out of broad defaults.",
    },
    notes: "Document MCP belongs to explicit office/document TTL sessions.",
  },
  {
    server: "openrouter-audio",
    necessity: "optional-on-demand",
    cost_band: "low",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 2,
      idle_rss_kib: 24104,
      idle_cpu_pct: 0,
      note: "Observed only under stale Kiba broad MCP config.",
    },
    notes: "Audio transcription is not an always-on agent responsibility.",
  },
  {
    server: "miro",
    necessity: "optional-on-demand",
    cost_band: "none",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 0,
      idle_rss_kib: 0,
      idle_cpu_pct: 0,
      note: "Remote HTTP MCP; no local process in the sampled runtime.",
    },
    notes: "Remote Miro MCP is an explicit collaboration/debug pack, not default runtime.",
  },
  {
    server: "miro-api",
    necessity: "optional-on-demand",
    cost_band: "low",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 2,
      idle_rss_kib: 24140,
      idle_cpu_pct: 0,
      note: "Observed only under stale Kiba broad MCP config.",
    },
    notes: "Miro API pack is a TTL collaboration/debug pack.",
  },
  {
    server: "excel",
    necessity: "optional-on-demand",
    cost_band: "low",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 2,
      idle_rss_kib: 24160,
      idle_cpu_pct: 0,
      note: "Observed only under stale Kiba broad MCP config.",
    },
    notes: "Office/spreadsheet pack; only for explicit TTL sessions.",
  },
  {
    server: "word",
    necessity: "optional-on-demand",
    cost_band: "none",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 0,
      idle_rss_kib: 0,
      idle_cpu_pct: 0,
      note: "No live process was observed after optional-pack gate; previous #785 snapshot measured 2 processes / 87256 KiB when stale defaults started it.",
    },
    notes: "Office document pack; only for explicit TTL sessions.",
  },
  {
    server: "email",
    necessity: "optional-on-demand",
    cost_band: "low",
    default_allowed_for_roles: [],
    opt_in_only: true,
    retired: false,
    measurement: {
      ...MCP_COST_CATALOG_SAMPLE,
      idle_process_count: 1,
      idle_rss_kib: 14844,
      idle_cpu_pct: 0,
      note: "Observed only under stale Kiba broad MCP config.",
    },
    notes: "Konoha mail integration uses src/adapters/email.ts; email MCP is not required by the minimal runtime.",
  },
];

export const ROLE_DEFAULT_MCP_ALLOWLISTS: readonly RoleDefaultMcpAllowlist[] = [
  {
    role: "telegram-bot-connector",
    agent_ids: ["naruto"],
    mcp_servers: ["konoha"],
    notes: "Keeps Naruto bot delegation/GitHub flow intact without Telethon, CRM, browser, or office MCPs.",
  },
  {
    role: "telegram-user-connector",
    agent_ids: ["sasuke"],
    mcp_servers: ["konoha", "telethon-channel", "bitrix24"],
    notes: "Keeps Sasuke user-account Telegram and CRM routing intact.",
  },
  {
    role: "monitoring-only",
    agent_ids: ["kiba"],
    mcp_servers: ["konoha"],
    notes: "Kiba is monitoring-only; corporate, browser, office, memory, and audio MCPs are excluded.",
  },
  {
    role: "sdd-developer-reviewer",
    agent_ids: ["kakashi", "shikadai", "guy"],
    mcp_servers: ["konoha"],
    notes: "SDD work uses local repo tools and Konoha handoff; shared external MCPs are opt-in only.",
  },
  {
    role: "qa",
    agent_ids: ["shino", "hinata"],
    mcp_servers: ["konoha"],
    notes: "QA defaults use Konoha plus TestBench capability, not direct Puppeteer MCP.",
  },
  {
    role: "external-source-connector",
    agent_ids: ["mirai"],
    mcp_servers: ["konoha", "bitrix24"],
    notes: "Mirai is connector-owned but on-demand; email uses the adapter path rather than email MCP.",
  },
  {
    role: "deprecated-compat",
    agent_ids: ["jiraiya", "ino", "inojin"],
    mcp_servers: ["konoha"],
    notes: "Deprecated compatibility agents stay parked and regenerate to Konoha-only if temporarily enabled.",
  },
];

export function getMcpCostCatalogEntry(server: string): McpCostCatalogEntry | undefined {
  return MCP_COST_CATALOG.find(entry => entry.server === server);
}

export function getRoleDefaultMcpAllowlist(role: string): RoleDefaultMcpAllowlist | undefined {
  return ROLE_DEFAULT_MCP_ALLOWLISTS.find(entry => entry.role === role);
}
