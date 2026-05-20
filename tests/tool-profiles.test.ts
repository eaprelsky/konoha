import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  getSandboxProfile,
  getToolProfile,
  buildMcpConfig,
  listSandboxProfiles,
  listToolProfiles,
  OPTIONAL_SHARED_MCP_PACKS,
  RETIRED_SHARED_MCP_PACKS,
  MCP_COST_CATALOG,
  ROLE_DEFAULT_MCP_ALLOWLISTS,
  resolveSharedMcpAllowlist,
  toolProfileToMcpAllowlist,
} from "../src/agent";

describe("tool and sandbox profiles", () => {
  test("lists named tool profiles with scopes", () => {
    const profiles = listToolProfiles();
    expect(profiles.map(p => p.id)).toContain("telegram-userbot");
    expect(getToolProfile("telegram-userbot")?.mcp_servers).toEqual(["telethon-channel", "bitrix24"]);
    expect(getToolProfile("diagnostics")?.scopes).toContain("execute");
    expect(getToolProfile("kiba-monitor-core")?.mcp_servers).toEqual(["konoha"]);
    expect(getToolProfile("browser-debug-ttl")?.mcp_servers).toEqual(["puppeteer"]);
    expect(getToolProfile("office-miro-debug-ttl")?.mcp_servers).toEqual(["excel", "word", "google-docs", "google-sheets", "miro", "miro-api"]);
  });

  test("maps tool profiles to MCP allowlists unless an explicit allowlist is present", () => {
    expect(toolProfileToMcpAllowlist("telegram-userbot")).toEqual(["telethon-channel", "bitrix24"]);
    expect(toolProfileToMcpAllowlist("diagnostics")).toEqual(["konoha"]);
    expect(toolProfileToMcpAllowlist("kiba-monitor-core")).toEqual(["konoha"]);
    expect(toolProfileToMcpAllowlist("full")).toBeUndefined();
    expect(resolveSharedMcpAllowlist(["yonote"], "telegram-userbot")).toEqual(["yonote"]);
  });

  test("keeps browser MCP out of non-debug shared tool profiles", () => {
    const browserServers = new Set(["puppeteer", "playwright", "browser"]);
    const allowedBrowserProfiles = new Set(["browser-debug-ttl"]);

    for (const profile of listToolProfiles()) {
      if (allowedBrowserProfiles.has(profile.id)) continue;
      expect(profile.mcp_servers.some(server => browserServers.has(server))).toBe(false);
    }
  });

  test("keeps Office, Miro, and spreadsheet MCPs out of non-debug shared tool profiles", () => {
    const officeMiroSpreadsheet = new Set(["excel", "word", "google-docs", "google-sheets", "miro", "miro-api"]);
    const allowedProfiles = new Set(["office-miro-debug-ttl"]);

    for (const profile of listToolProfiles()) {
      if (allowedProfiles.has(profile.id)) continue;
      expect(profile.mcp_servers.some(server => officeMiroSpreadsheet.has(server))).toBe(false);
    }
  });

  test("runtime-gates optional heavy shared MCP packs from broad profiles", () => {
    expect([...OPTIONAL_SHARED_MCP_PACKS].sort()).toEqual([
      "excel",
      "google-docs",
      "google-sheets",
      "miro",
      "miro-api",
      "puppeteer",
      "word",
    ]);
    const runtimeSource = readFileSync(join(import.meta.dir, "..", "src", "agent", "runtime.ts"), "utf-8");
    expect(runtimeSource).toContain("skipping optional shared MCP pack");
    expect(runtimeSource).toContain("skipping disabled experimental MCP pack");
  });

  test("retired Mempalace MCP is excluded from active runtime profiles", () => {
    expect([...RETIRED_SHARED_MCP_PACKS]).toEqual(["mempalace"]);
    for (const profile of listToolProfiles()) {
      expect(profile.mcp_servers).not.toContain("mempalace");
    }

    const runtimeSource = readFileSync(join(import.meta.dir, "..", "src", "agent", "runtime.ts"), "utf-8");
    expect(runtimeSource).toContain("skipping retired shared MCP pack");
    expect(runtimeSource).toContain("retired from active Konoha runtime surface");
  });

  test("runtime ignores retired Mempalace even when a stale allowlist mentions it", async () => {
    const config = await buildMcpConfig([], {
      KONOHA_URL: "http://127.0.0.1:3200",
      KONOHA_TOKEN: "test-token",
    }, ["mempalace"]);

    expect(Object.keys(config.mcpServers).sort()).toEqual(["konoha"]);
  });

  test("MCP cost catalog covers the lean-runtime measurement scope", () => {
    const requiredServers = [
      "konoha",
      "telethon-channel",
      "bitrix24",
      "gitlab",
      "yonote",
      "yandex-tracker",
      "memory",
      "mempalace",
      "puppeteer",
      "sequential-thinking",
      "caldav",
      "google-sheets",
      "google-docs",
      "openrouter-audio",
      "miro",
      "miro-api",
      "excel",
      "word",
      "email",
    ];
    const byServer = new Map(MCP_COST_CATALOG.map(entry => [entry.server, entry]));

    expect(MCP_COST_CATALOG.map(entry => entry.server).sort()).toEqual([...requiredServers].sort());
    for (const server of requiredServers) {
      const entry = byServer.get(server);
      expect(entry).toBeDefined();
      expect(entry?.measurement.sampled_at).toMatch(/^2026-05-20T/);
      expect(entry?.measurement.source).toContain("ps -eo");
      expect(entry?.measurement.idle_process_count).toBeGreaterThanOrEqual(0);
      expect(entry?.measurement.idle_rss_kib).toBeGreaterThanOrEqual(0);
      expect(entry?.measurement.idle_cpu_pct).toBeGreaterThanOrEqual(0);
      expect(entry?.notes.length ?? 0).toBeGreaterThan(10);
    }
  });

  test("MCP cost catalog marks heavy and retired packs as non-default", () => {
    const byServer = new Map(MCP_COST_CATALOG.map(entry => [entry.server, entry]));
    const heavyOptIn = [
      "gitlab",
      "memory",
      "puppeteer",
      "sequential-thinking",
    ];

    for (const server of heavyOptIn) {
      const entry = byServer.get(server);
      expect(entry?.cost_band).toBe("heavy");
      expect(entry?.opt_in_only).toBe(true);
      expect(entry?.default_allowed_for_roles).toEqual([]);
    }

    expect(byServer.get("mempalace")).toMatchObject({
      necessity: "retired",
      retired: true,
      default_allowed_for_roles: [],
    });
  });

  test("role default MCP allowlists preserve critical Naruto and Sasuke flows", () => {
    const byRole = new Map(ROLE_DEFAULT_MCP_ALLOWLISTS.map(entry => [entry.role, entry]));

    expect(byRole.get("telegram-bot-connector")?.mcp_servers).toEqual(["konoha"]);
    expect(byRole.get("telegram-user-connector")?.mcp_servers).toEqual(["konoha", "telethon-channel", "bitrix24"]);
    expect(byRole.get("monitoring-only")?.mcp_servers).toEqual(["konoha"]);
    expect(byRole.get("sdd-developer-reviewer")?.mcp_servers).toEqual(["konoha"]);

    for (const entry of ROLE_DEFAULT_MCP_ALLOWLISTS) {
      expect(entry.mcp_servers).not.toContain("mempalace");
      expect(entry.mcp_servers).not.toContain("puppeteer");
      expect(entry.mcp_servers).not.toContain("excel");
      expect(entry.mcp_servers).not.toContain("word");
      expect(entry.mcp_servers).not.toContain("google-docs");
      expect(entry.mcp_servers).not.toContain("google-sheets");
      expect(entry.mcp_servers).not.toContain("miro");
      expect(entry.mcp_servers).not.toContain("miro-api");
    }
  });

  test("keeps sandbox profiles separate from runtime adapters", () => {
    expect(listSandboxProfiles().map(p => p.id)).toEqual(["docker", "process", "remote", "tmux"]);
    expect(getSandboxProfile("tmux")?.type).toBe("tmux");
    expect(getSandboxProfile("docker")?.type).toBe("docker");
  });
});
