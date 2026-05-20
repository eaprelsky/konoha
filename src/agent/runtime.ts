/**
 * agent/runtime.ts — Provider resolution, launch command building, MCP config.
 * Extracted from agent-lifecycle.ts (#509).
 */

import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import type { AgentProvider, AgentDef } from "./types";
import { createLogger } from "../logger";
import { featureForMcpPack, isFeatureEnabled } from "../feature-flags";
import { profileAgentProvider, resolveLLMClientProfile } from "./llm-client-profiles";
import { getMcpCostCatalogEntry } from "./mcp-cost-catalog";

const log = createLogger("agent:runtime");

const DEFAULT_AGENT_MODEL = "sonnet";
const CODEX_CONFIG_PATH = "/home/ubuntu/.codex/config.toml";
const CODEX_BIN_CANDIDATES = [
  process.env.CODEX_BIN,
  "/home/ubuntu/.npm-global/bin/codex",
  "/home/ubuntu/.bun/bin/codex",
  "codex",
].filter(Boolean) as string[];
const AGENT_WORKDIR_ROOT = "/opt/shared/agent-workdirs";
const CLAUDE_WRAPPER_PATH = "/home/ubuntu/konoha/scripts/run-claude-agent.sh";

export { AGENT_WORKDIR_ROOT, DEFAULT_AGENT_MODEL };

// ── Shell / TOML helpers ────────────────────────────────────────────────────

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function tomlEscape(value: string): string {
  return JSON.stringify(value);
}

function toToml(value: string | string[] | Record<string, string>): string {
  if (typeof value === "string") return tomlEscape(value);
  if (Array.isArray(value)) return `[${value.map(tomlEscape).join(", ")}]`;
  return `{ ${Object.entries(value).map(([k, v]) => `${k} = ${tomlEscape(v)}`).join(", ")} }`;
}

function configPathSegment(value: string): string {
  return /^[A-Za-z0-9_]+$/.test(value) ? value : JSON.stringify(value);
}

function codexServerName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "mcp_server";
}

export function resolveCodexBinary(): string {
  for (const candidate of CODEX_BIN_CANDIDATES) {
    if (candidate === "codex" || existsSync(candidate)) return candidate;
  }
  return "codex";
}

function ensureCodexProjectTrusted(workdir: string): void {
  const section = `[projects.${JSON.stringify(workdir)}]`;
  const block = `${section}
trust_level = "trusted"
`;
  const current = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, "utf-8") : "";
  if (current.includes(section)) return;
  const next = current.trimEnd() ? `${current.trimEnd()}

${block}` : block;
  const { mkdirSync, writeFileSync } = require("fs");
  const { join } = require("path");
  mkdirSync(join(CODEX_CONFIG_PATH, ".."), { recursive: true });
  writeFileSync(CODEX_CONFIG_PATH, next, "utf-8");
}

// ── Provider resolution ────────────────────────────────────────────────────

export function resolveAgentRuntime(def: Pick<AgentDef, "model" | "runtime" | "llm_client_profile">): { provider: AgentProvider; runtimeModel: string } {
  const profile = resolveLLMClientProfile(def);
  const profileProvider = profile ? profileAgentProvider(profile) : undefined;
  if (profile && profileProvider) {
    return { provider: profileProvider, runtimeModel: profile.runtime_model ?? profile.model };
  }
  if (def.llm_client_profile) {
    throw new Error(`Unknown LLM client profile: ${def.llm_client_profile}`);
  }

  const raw = (def.model || DEFAULT_AGENT_MODEL).trim();
  const namespaced = raw.match(/^(claude|codex|cursor|glm):(.*)$/);
  if (def.runtime) {
    return {
      provider: def.runtime,
      runtimeModel: (namespaced ? namespaced[2] : raw || DEFAULT_AGENT_MODEL).trim(),
    };
  }
  if (namespaced) {
    return {
      provider: namespaced[1] as AgentProvider,
      runtimeModel: (namespaced[2] || DEFAULT_AGENT_MODEL).trim(),
    };
  }
  if (raw.startsWith("claude-")) return { provider: "claude", runtimeModel: raw };
  if (raw.startsWith("glm-")) return { provider: "glm", runtimeModel: raw };
  if (raw.startsWith("cursor-")) return { provider: "cursor", runtimeModel: raw.slice("cursor-".length) || "sonnet-4" };
  if (raw.startsWith("codex-") && raw !== "codex") return { provider: "codex", runtimeModel: raw.slice("codex-".length) || "gpt-5" };
  if (raw.startsWith("gpt-") || raw.startsWith("o1") || raw.startsWith("o3") || raw.startsWith("o4")) {
    return { provider: "codex", runtimeModel: raw };
  }
  if (raw.startsWith("sonnet-") || raw === "gpt-5") {
    return { provider: "cursor", runtimeModel: raw };
  }
  return { provider: "claude", runtimeModel: raw };
}

export function formatAgentModel(def: Pick<AgentDef, "model" | "runtime">): string {
  const raw = (def.model || DEFAULT_AGENT_MODEL).trim();
  if (/^(claude|codex|cursor|glm):/.test(raw)) return raw;
  if (def.runtime) return `${def.runtime}:${raw}`;
  return raw;
}

function normalizeClaudeRuntimeModel(value: string): string {
  const raw = value.trim();
  switch (raw) {
    case "":
    case "auto":
    case "claude":
    case "sonnet":
    case "claude-sonnet-4-6":
    case "glm-5.1":
      return "sonnet";
    case "haiku":
    case "claude-haiku-4-5-20251001":
    case "glm-4.5-air":
      return "haiku";
    case "opus":
    case "claude-opus-4-6":
      return "opus";
    default:
      return raw;
  }
}

// ── MCP config ─────────────────────────────────────────────────────────────

const GLOBAL_ENV_PATH = "/opt/konoha/.env.global";
const CANONICAL_SHARED_MCP_CONFIG_PATH = "/opt/shared/comind-template/.mcp.json";
const SHARED_MCP_CONFIG_PATHS = [
  CANONICAL_SHARED_MCP_CONFIG_PATH,
  "/home/ubuntu/.mcp.json",
] as const;
export const OPTIONAL_SHARED_MCP_PACKS = new Set([
  "excel",
  "word",
  "google-docs",
  "google-sheets",
  "miro",
  "miro-api",
  "puppeteer",
]);
export const RETIRED_SHARED_MCP_PACKS = new Set([
  "mempalace",
]);
export const ON_DEMAND_SHARED_MCP_PACKS: ReadonlyMap<string, { feature: string; idle_timeout_sec: number; reason: string }> = new Map([
  ["gitlab", {
    feature: "",
    idle_timeout_sec: 900,
    reason: "GitLab MCP is a rare repository/debug pack and must not spawn through npx during persistent startup",
  }],
  ["filesystem", {
    feature: "",
    idle_timeout_sec: 900,
    reason: "Filesystem MCP overlaps local tools and must not spawn through npx during persistent startup",
  }],
  ["memory", {
    feature: "corporate-memory",
    idle_timeout_sec: 900,
    reason: "Generic memory MCP is rare corporate-memory tooling and must not spawn through npx during persistent startup",
  }],
  ["puppeteer", {
    feature: "direct-browser-mcp",
    idle_timeout_sec: 900,
    reason: "direct browser MCP is a heavy debug pack; default GUI checks use TestBench",
  }],
  ["sequential-thinking", {
    feature: "",
    idle_timeout_sec: 900,
    reason: "Sequential-thinking MCP is an analysis helper and must not spawn through npx during persistent startup",
  }],
  ["google-sheets", {
    feature: "office-miro-mcp",
    idle_timeout_sec: 900,
    reason: "Google Sheets MCP is office tooling and must not spawn through uvx during persistent startup",
  }],
  ["excel", {
    feature: "office-miro-mcp",
    idle_timeout_sec: 900,
    reason: "Excel MCP is office tooling and must not spawn through uvx during persistent startup",
  }],
  ["word", {
    feature: "office-miro-mcp",
    idle_timeout_sec: 900,
    reason: "Word MCP is office tooling and must not spawn through uvx during persistent startup",
  }],
  ["google-docs", {
    feature: "office-miro-mcp",
    idle_timeout_sec: 900,
    reason: "Google Docs MCP is office tooling and must not spawn through npx during persistent startup",
  }],
] as const);
const MCP_BIN_OVERRIDES = {
  bun: "/home/ubuntu/.bun/bin/bun",
  node: "/usr/bin/node",
  uv: "/home/ubuntu/.local/bin/uv",
  uvx: "/home/ubuntu/.local/bin/uvx",
  "mcp-email-server": "/home/ubuntu/.local/bin/mcp-email-server",
} as const;

export function loadGlobalEnv(): Record<string, string> {
  if (!existsSync(GLOBAL_ENV_PATH)) return {};
  try {
    return readFileSync(GLOBAL_ENV_PATH, "utf-8")
      .split("\n")
      .filter(l => l.trim() && !l.startsWith("#") && l.includes("="))
      .reduce<Record<string, string>>((acc, line) => {
        const eq = line.indexOf("=");
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key) acc[key] = val;
        return acc;
      }, {});
  } catch {
    return {};
  }
}

function loadProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function resolveVars(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => vars[key] ?? `\${${key}}`);
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

type RawMcpServerDef = {
  type?: "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
};
type ResolvedStdioMcpServerDef = { command: string; args?: string[]; env?: Record<string, string>; timeout?: number };
type ResolvedHttpMcpServerDef = { type: "http"; url: string; env?: Record<string, string>; timeout?: number };
type ResolvedMcpServerDef = ResolvedStdioMcpServerDef | ResolvedHttpMcpServerDef;
export type McpConfig = { mcpServers: Record<string, ResolvedMcpServerDef> };
export type McpBuildMode = "startup" | "task";
export type McpPackReceiptEntry = {
  server: string;
  policy: "included" | "deferred" | "skipped";
  reason: string;
  feature?: string;
  idle_timeout_sec?: number;
  estimated_idle_rss_kib?: number;
};
export type McpBuildReceipt = {
  schema_version: 1;
  mode: McpBuildMode;
  requested_on_demand_packs: string[];
  included_packs: McpPackReceiptEntry[];
  deferred_packs: McpPackReceiptEntry[];
  skipped_packs: McpPackReceiptEntry[];
  estimated_startup_rss_saved_kib: number;
};
export type McpBuildOptions = {
  mode?: McpBuildMode;
  requestedOnDemandPacks?: string[];
};
type SharedMcpLoadResult = {
  servers: Record<string, ResolvedMcpServerDef>;
  receipt: McpBuildReceipt;
};

function sharedMcpConfigPaths(vars: Record<string, string>): string[] {
  const override = vars.KONOHA_SHARED_MCP_CONFIG_PATH;
  if (override?.trim()) return override.split(":").map(item => item.trim()).filter(Boolean);
  return [...SHARED_MCP_CONFIG_PATHS];
}

function createReceipt(mode: McpBuildMode, requestedOnDemandPacks: string[]): McpBuildReceipt {
  return {
    schema_version: 1,
    mode,
    requested_on_demand_packs: [...requestedOnDemandPacks].sort(),
    included_packs: [],
    deferred_packs: [],
    skipped_packs: [],
    estimated_startup_rss_saved_kib: 0,
  };
}

function receiptEntry(server: string, policy: McpPackReceiptEntry["policy"], reason: string, extra: Partial<McpPackReceiptEntry> = {}): McpPackReceiptEntry {
  const cost = getMcpCostCatalogEntry(server);
  return {
    server,
    policy,
    reason,
    ...(cost?.measurement.idle_rss_kib ? { estimated_idle_rss_kib: cost.measurement.idle_rss_kib } : {}),
    ...extra,
  };
}

function addReceipt(receipt: McpBuildReceipt, entry: McpPackReceiptEntry): void {
  if (entry.policy === "included") receipt.included_packs.push(entry);
  if (entry.policy === "deferred") {
    receipt.deferred_packs.push(entry);
    receipt.estimated_startup_rss_saved_kib += entry.estimated_idle_rss_kib ?? 0;
  }
  if (entry.policy === "skipped") receipt.skipped_packs.push(entry);
}

function onDemandIdleTimeoutSec(server: string, vars: Record<string, string>): number {
  const configured = Number.parseInt(vars.KONOHA_MCP_ON_DEMAND_IDLE_TIMEOUT_SEC || "", 10);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return ON_DEMAND_SHARED_MCP_PACKS.get(server)?.idle_timeout_sec ?? 900;
}

function getLiveBitrixWebhook(): string | undefined {
  return process.env.BITRIX24_WEBHOOK_URL || process.env.CHATBOT_BITRIX_WEBHOOK || undefined;
}

function resolveMcpPathArg(value: string, baseDir: string): string {
  if (isAbsolute(value)) return value;
  if (value === ".") return baseDir;
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("mcp/")) return resolve(baseDir, value);
  return value;
}

function resolveMcpCommand(command: string, baseDir: string): string {
  if (isAbsolute(command)) return command;
  const override = MCP_BIN_OVERRIDES[command as keyof typeof MCP_BIN_OVERRIDES];
  if (override && existsSync(override)) return override;
  if (command.startsWith("./") || command.startsWith("../") || command.startsWith("mcp/")) return resolve(baseDir, command);
  return command;
}

function resolveMcpArgs(args: string[] | undefined, baseDir: string): string[] | undefined {
  if (!args?.length) return undefined;
  return args.map((arg, index) => {
    const prev = args[index - 1];
    if (prev === "--directory" || prev === "--cwd") return resolveMcpPathArg(arg, baseDir);
    if (arg === "." || arg.startsWith("./") || arg.startsWith("../") || arg.startsWith("mcp/")) return resolveMcpPathArg(arg, baseDir);
    return arg;
  });
}

function wrapOnDemandServer(server: ResolvedMcpServerDef, timeoutSec: number): ResolvedMcpServerDef {
  if (!("command" in server)) return server;
  return {
    command: "/home/ubuntu/.bun/bin/bun",
    args: [
      "run",
      "/home/ubuntu/konoha/scripts/mcp-idle-wrapper.ts",
      "--timeout-sec",
      String(timeoutSec),
      "--",
      server.command,
      ...(server.args ?? []),
    ],
    ...(server.env ? { env: server.env } : {}),
    ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
  };
}

function loadSharedMcpServers(
  agentEnv: Record<string, string>,
  allowlist?: string[],
  options: McpBuildOptions = {},
): SharedMcpLoadResult {
  const globalEnv = loadGlobalEnv();
  const vars = { ...loadProcessEnv(), ...globalEnv, ...agentEnv };
  const merged: Record<string, ResolvedMcpServerDef> = {};
  const mode = options.mode ?? "startup";
  const requestedOnDemandPacks = options.requestedOnDemandPacks ?? parseCsv(vars.KONOHA_MCP_SESSION_PACKS);
  const requestedOnDemand = new Set(requestedOnDemandPacks);
  const receipt = createReceipt(mode, requestedOnDemandPacks);
  // Distinguish between "no allowlist provided" (include broad shared MCPs
  // except runtime-gated optional packs) and "explicit empty allowlist"
  // (include none of the shared MCPs).
  const allowed = allowlist ? new Set(allowlist) : null;

  for (const configPath of sharedMcpConfigPaths(vars)) {
    if (!existsSync(configPath)) continue;
    const configDir = dirname(configPath);
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8")) as { mcpServers?: Record<string, RawMcpServerDef> };
      for (const [name, server] of Object.entries(raw.mcpServers ?? {})) {
        if (RETIRED_SHARED_MCP_PACKS.has(name)) {
          log.info("skipping retired shared MCP pack", {
            server: name,
            path: configPath,
            reason: "retired from active Konoha runtime surface",
          });
          continue;
        }
        if (allowed && !allowed.has(name)) continue;
        if (!allowed && OPTIONAL_SHARED_MCP_PACKS.has(name)) {
          log.info("skipping optional shared MCP pack", {
            server: name,
            path: configPath,
            reason: "requires explicit allowlist/tool_profile with TTL",
          });
          addReceipt(receipt, receiptEntry(name, "skipped", "requires explicit allowlist/tool_profile with TTL"));
          continue;
        }
        const requiredFeature = featureForMcpPack(name);
        if (requiredFeature && !isFeatureEnabled(requiredFeature, vars)) {
          log.info("skipping disabled experimental MCP pack", {
            server: name,
            path: configPath,
            feature: requiredFeature,
            reason: "feature flag disabled by selected Konoha profile",
          });
          addReceipt(receipt, receiptEntry(name, "skipped", "feature flag disabled by selected Konoha profile", { feature: requiredFeature }));
          continue;
        }
        const onDemand = ON_DEMAND_SHARED_MCP_PACKS.get(name);
        if (onDemand && (mode !== "task" || !requestedOnDemand.has(name))) {
          const timeoutSec = onDemandIdleTimeoutSec(name, vars);
          log.info("deferring on-demand shared MCP pack", {
            server: name,
            path: configPath,
            feature: onDemand.feature,
            idle_timeout_sec: timeoutSec,
            reason: onDemand.reason,
          });
          addReceipt(receipt, receiptEntry(name, "deferred", onDemand.reason, {
            ...(onDemand.feature ? { feature: onDemand.feature } : {}),
            idle_timeout_sec: timeoutSec,
          }));
          continue;
        }
        if (merged[name]) continue;

        let resolvedEnv = server.env && Object.keys(server.env).length
          ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, resolveVars(v, vars)]))
          : undefined;

        if (name === "bitrix24") {
          const liveWebhook = vars.BITRIX24_WEBHOOK_URL || vars.CHATBOT_BITRIX_WEBHOOK;
          if (liveWebhook) {
            (resolvedEnv ??= {}).BITRIX24_WEBHOOK_URL = liveWebhook;
          }
        }

        if (server.type === "http" && server.url) {
          const resolvedServer: ResolvedMcpServerDef = {
            type: "http",
            url: resolveVars(server.url, vars),
            ...(resolvedEnv ? { env: resolvedEnv } : {}),
            ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
          };
          merged[name] = onDemand ? wrapOnDemandServer(resolvedServer, onDemandIdleTimeoutSec(name, vars)) : resolvedServer;
          if (onDemand) {
            addReceipt(receipt, receiptEntry(name, "included", "on-demand pack requested for this task/session", {
              ...(onDemand.feature ? { feature: onDemand.feature } : {}),
              idle_timeout_sec: onDemandIdleTimeoutSec(name, vars),
            }));
          }
          continue;
        }

        if (!server.command) continue;

        const resolvedArgs = resolveMcpArgs(server.args?.map(arg => resolveVars(arg, vars)), configDir);
        const resolvedServer: ResolvedMcpServerDef = {
          command: resolveMcpCommand(resolveVars(server.command, vars), configDir),
          ...(resolvedArgs?.length ? { args: resolvedArgs } : {}),
          ...(resolvedEnv ? { env: resolvedEnv } : {}),
          ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
        };
        merged[name] = onDemand ? wrapOnDemandServer(resolvedServer, onDemandIdleTimeoutSec(name, vars)) : resolvedServer;
        if (onDemand) {
          addReceipt(receipt, receiptEntry(name, "included", "on-demand pack requested for this task/session", {
            ...(onDemand.feature ? { feature: onDemand.feature } : {}),
            idle_timeout_sec: onDemandIdleTimeoutSec(name, vars),
          }));
        }
      }
    } catch (error) {
      log.warn("failed to load shared MCP config", { path: configPath, error: (error as Error).message });
    }
  }

  return { servers: merged, receipt };
}

type McpServerDef = { name: string; command: string; args?: string[]; env?: Record<string, string>; timeout?: number };

const KONOHA_MCP_SERVER: McpServerDef & { name: string } = {
  name: "konoha",
  command: "/home/ubuntu/.bun/bin/bun",
  args: ["run", "/home/ubuntu/konoha/src/mcp.ts"],
  env: {
    KONOHA_URL: "${KONOHA_URL}",
    KONOHA_TOKEN: "${KONOHA_TOKEN}",
    no_proxy: "127.0.0.1,localhost",
  },
};

export async function buildMcpConfig(
  capabilities: string[],
  agentEnv: Record<string, string>,
  sharedMcpAllowlist?: string[],
): Promise<McpConfig> {
  const result = await buildMcpConfigWithReceipt(capabilities, agentEnv, sharedMcpAllowlist);
  return result.config;
}

export async function buildMcpConfigWithReceipt(
  capabilities: string[],
  agentEnv: Record<string, string>,
  sharedMcpAllowlist?: string[],
  options: McpBuildOptions = {},
): Promise<{ config: McpConfig; receipt: McpBuildReceipt }> {
  const { redis } = await import("../redis");
  const globalEnv = loadGlobalEnv();
  const vars = { ...loadProcessEnv(), ...globalEnv, ...agentEnv };
  const shared = loadSharedMcpServers(agentEnv, sharedMcpAllowlist, options);

  const servers: Record<string, ResolvedMcpServerDef> = {
    ...shared.servers,
  };

  const kEnv = Object.fromEntries(
    Object.entries(KONOHA_MCP_SERVER.env!).map(([k, v]) => [k, resolveVars(v, vars)])
  );
  if (capabilities.length > 0) {
    kEnv["KONOHA_SKILLS"] = capabilities.join(",");
  }
  servers[KONOHA_MCP_SERVER.name] = {
    command: KONOHA_MCP_SERVER.command,
    args: KONOHA_MCP_SERVER.args,
    env: kEnv,
  };

  for (const skillId of capabilities) {
    const raw = await redis.get(`konoha:skill:${skillId}`).catch(() => null);
    if (!raw) continue;
    const skill = JSON.parse(raw) as { mcp_servers?: McpServerDef[] };
    if (!skill.mcp_servers?.length) continue;
    for (const srv of skill.mcp_servers) {
      const resolvedEnv = srv.env
        ? Object.fromEntries(Object.entries(srv.env).map(([k, v]) => [k, resolveVars(v, vars)]))
        : undefined;
      const resolvedArgs = srv.args?.map(a => resolveVars(a, vars));
      servers[srv.name] = {
        command: resolveVars(srv.command, vars),
        ...(resolvedArgs?.length ? { args: resolvedArgs } : {}),
        ...(resolvedEnv && Object.keys(resolvedEnv).length ? { env: resolvedEnv } : {}),
      };
    }
  }

  return { config: { mcpServers: servers }, receipt: shared.receipt };
}

function buildCodexMcpConfigArgs(mcpConfig: McpConfig): string[] {
  const args: string[] = [];
  for (const [name, server] of Object.entries(mcpConfig.mcpServers)) {
    const path = `mcp_servers.${codexServerName(name)}`;
    if ("type" in server && server.type === "http") {
      args.push("-c", `${path}.type=${toToml(server.type)}`);
      args.push("-c", `${path}.url=${toToml(server.url)}`);
      continue;
    }
    if (!("command" in server)) continue;
    args.push("-c", `${path}.command=${toToml(server.command)}`);
    if (server.args?.length) args.push("-c", `${path}.args=${toToml(server.args)}`);
    if (server.env && Object.keys(server.env).length) args.push("-c", `${path}.env=${toToml(server.env)}`);
  }
  return args;
}

export function buildLaunchCommand(
  def: Pick<AgentDef, "model" | "runtime" | "llm_client_profile" | "reasoning_effort" | "codex_disable_features" | "sandbox_profile">,
  workdir: string,
  mcpConfigPath: string,
  mcpConfig: McpConfig,
): { provider: AgentProvider; command: string } {
  // #572: sandbox_profile is always "tmux" for now — all agents run in tmux sessions.
  // When Docker/remote sandboxes are implemented, this function will dispatch
  // to the appropriate launch path based on def.sandbox_profile.
  const runtime = resolveAgentRuntime(def);
  const profile = resolveLLMClientProfile(def);
  const reasoningEffort = def.reasoning_effort ?? profile?.reasoning_effort;

  if (runtime.provider === "codex") {
    const args = [
      resolveCodexBinary(),
      "--no-alt-screen",
      "--model", runtime.runtimeModel,
      "--dangerously-bypass-approvals-and-sandbox",
      "-C", workdir,
      ...(reasoningEffort ? ["-c", `model_reasoning_effort=${toToml(reasoningEffort)}`] : []),
      ...(def.codex_disable_features ?? []).flatMap(flag => ["--disable", flag]),
      ...buildCodexMcpConfigArgs(mcpConfig),
    ];
    return { provider: runtime.provider, command: args.map(shellEscape).join(" ") };
  }

  if (runtime.provider === "cursor") {
    const args = [
      "cursor-agent",
      "--yolo",
      "--approve-mcps",
      "--sandbox", "disabled",
      "--workspace", workdir,
    ];
    if (runtime.runtimeModel && runtime.runtimeModel !== "auto") {
      args.splice(1, 0, "--model", runtime.runtimeModel);
    }
    return { provider: runtime.provider, command: args.map(shellEscape).join(" ") };
  }

  const args = [
    ...(runtime.provider === "glm" ? ["env", "KONOHA_CLAUDE_PROVIDER_PROFILE=glm"] : []),
    CLAUDE_WRAPPER_PATH,
    normalizeClaudeRuntimeModel(runtime.runtimeModel),
    "--dangerously-skip-permissions",
    "--permission-mode", "bypassPermissions",
    "--mcp-config", mcpConfigPath,
  ];
  return { provider: runtime.provider, command: args.map(shellEscape).join(" ") };
}

export { ensureCodexProjectTrusted, getLiveBitrixWebhook };
