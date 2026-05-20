/**
 * agent/tool-profiles.ts — Tool/plugin profiles (#571).
 *
 * Each profile maps to a set of MCP server names and access scopes.
 * Permanent agents reference a tool_profile id in AgentTemplate.
 */

import type { ToolProfile } from "./types";

const PROFILES: Record<string, ToolProfile> = {
  default: {
    id: "default",
    name: "Default (Konoha bus only)",
    mcp_servers: ["konoha"],
    scopes: ["read", "write"],
  },
  full: {
    id: "full",
    name: "Full access (all shared MCPs)",
    mcp_servers: [], // empty = broad shared MCPs minus runtime-gated optional packs
    scopes: ["read", "write", "execute"],
    notes: "Manual/debug profile only. Office/Miro/spreadsheet/browser packs still require explicit TTL profiles; direct browser MCP is task/session on-demand only.",
  },
  readonly: {
    id: "readonly",
    name: "Read-only (Konoha bus, no writes)",
    mcp_servers: ["konoha"],
    scopes: ["read"],
    notes: "Suitable for observer/auditor agents.",
  },
  "telegram-bot": {
    id: "telegram-bot",
    name: "Telegram bot responder",
    mcp_servers: [],
    scopes: ["read", "write", "execute"],
    dangerous_tools: ["shell", "git-write"],
    notes: "Naruto currently needs broad system access; keep explicit shared_mcp_allowlist=[] until least-privilege is completed.",
  },
  "telegram-userbot": {
    id: "telegram-userbot",
    name: "Telegram userbot responder",
    mcp_servers: ["telethon-channel", "bitrix24"],
    scopes: ["read", "write"],
    dangerous_tools: ["telegram-send-user"],
  },
  "telegram-userbot-yonote-read": {
    id: "telegram-userbot-yonote-read",
    name: "Telegram userbot with bounded Yonote read context",
    mcp_servers: ["telethon-channel", "bitrix24", "yonote"],
    scopes: ["read", "write"],
    dangerous_tools: ["telegram-send-user"],
    notes: "Task/session overlay for Sasuke. Yonote is read/search-only by policy, gated by corporate-memory, and deferred from persistent startup.",
  },
  diagnostics: {
    id: "diagnostics",
    name: "Diagnostics and alerting",
    mcp_servers: ["konoha"],
    scopes: ["read", "write", "execute"],
    dangerous_tools: ["systemctl", "tmux", "redis-cli"],
    notes: "Operational profile for Kiba/Kakashi-style diagnostics. Shared browser MCPs are intentionally excluded; GUI checks use TestBench.",
  },
  "kiba-monitor-core": {
    id: "kiba-monitor-core",
    name: "Kiba monitoring core",
    mcp_servers: ["konoha"],
    scopes: ["read", "write", "execute"],
    dangerous_tools: ["konoha-health-actions"],
    notes: "Kiba default profile. Konoha health/action tools only; corporate, memory, browser, Office, Miro, calendar, audio, and document MCPs require explicit time-boxed diagnostic profiles. MemPalace is retired and excluded from active runtime profiles.",
  },
  "browser-debug-ttl": {
    id: "browser-debug-ttl",
    name: "Direct browser MCP for time-boxed QA/debug",
    mcp_servers: ["puppeteer"],
    scopes: ["read", "write", "execute"],
    dangerous_tools: ["browser-automation"],
    notes: "Not for always-on agents. Requires direct-browser-mcp feature flag and KONOHA_MCP_SESSION_PACKS=puppeteer for a task/session; the pack is wrapped with an idle timeout.",
  },
  "office-miro-debug-ttl": {
    id: "office-miro-debug-ttl",
    name: "Office, Miro, and spreadsheet MCPs for time-boxed debug",
    mcp_servers: ["excel", "word", "google-docs", "google-sheets", "miro", "miro-api"],
    scopes: ["read", "write", "execute"],
    dangerous_tools: ["document-write", "spreadsheet-write", "miro-write"],
    notes: "Not for always-on agents. Requires office-miro-mcp feature flag plus explicit on-demand document/spreadsheet/whiteboard debug session with operator-approved TTL and resource limits.",
  },
  "business-ops": {
    id: "business-ops",
    name: "Business operations",
    mcp_servers: ["bitrix24"],
    scopes: ["read", "write"],
  },
  "knowledge-readwrite": {
    id: "knowledge-readwrite",
    name: "Knowledge base read/write",
    mcp_servers: ["yonote"],
    scopes: ["read", "write"],
    notes: "Requires corporate-memory feature flag before Yonote/memory MCP packs are attached.",
  },
};

export function listToolProfiles(): ToolProfile[] {
  return Object.values(PROFILES).sort((a, b) => a.id.localeCompare(b.id));
}

export function getToolProfile(id: string | undefined): ToolProfile | undefined {
  return id ? PROFILES[id] : undefined;
}

export function toolProfileToMcpAllowlist(id: string | undefined): string[] | undefined {
  const profile = getToolProfile(id);
  if (!profile) return undefined;
  // Empty mcp_servers means "all" (no filtering)
  if (profile.mcp_servers.length === 0) return undefined;
  return profile.mcp_servers;
}

export function resolveSharedMcpAllowlist(explicitAllowlist: string[] | undefined, toolProfileId: string | undefined): string[] | undefined {
  if (explicitAllowlist !== undefined) return explicitAllowlist;
  return toolProfileToMcpAllowlist(toolProfileId);
}
