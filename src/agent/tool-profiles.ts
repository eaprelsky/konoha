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
    mcp_servers: [], // empty = no allowlist filtering, include all shared MCPs
    scopes: ["read", "write", "execute"],
    notes: "Manual/debug profile only. Do not assign to always-on or monitoring agents by default.",
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
  diagnostics: {
    id: "diagnostics",
    name: "Diagnostics and alerting",
    mcp_servers: ["konoha"],
    scopes: ["read", "write", "execute"],
    dangerous_tools: ["systemctl", "tmux", "redis-cli"],
    notes: "Operational profile for Kiba/Kakashi-style diagnostics. Shared browser MCPs are intentionally excluded; GUI checks use TestBench.",
  },
  "browser-debug-ttl": {
    id: "browser-debug-ttl",
    name: "Direct browser MCP for time-boxed QA/debug",
    mcp_servers: ["puppeteer"],
    scopes: ["read", "write", "execute"],
    dangerous_tools: ["browser-automation"],
    notes: "Not for always-on agents. Use only for explicit QA/debug sessions with operator-approved TTL and resource limits; default GUI checks use TestBench.",
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
