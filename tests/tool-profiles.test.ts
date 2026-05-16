import { describe, expect, test } from "bun:test";
import {
  getSandboxProfile,
  getToolProfile,
  listSandboxProfiles,
  listToolProfiles,
  resolveSharedMcpAllowlist,
  toolProfileToMcpAllowlist,
} from "../src/agent";

describe("tool and sandbox profiles", () => {
  test("lists named tool profiles with scopes", () => {
    const profiles = listToolProfiles();
    expect(profiles.map(p => p.id)).toContain("telegram-userbot");
    expect(getToolProfile("telegram-userbot")?.mcp_servers).toEqual(["telethon-channel", "bitrix24"]);
    expect(getToolProfile("diagnostics")?.scopes).toContain("execute");
    expect(getToolProfile("browser-debug-ttl")?.mcp_servers).toEqual(["puppeteer"]);
  });

  test("maps tool profiles to MCP allowlists unless an explicit allowlist is present", () => {
    expect(toolProfileToMcpAllowlist("telegram-userbot")).toEqual(["telethon-channel", "bitrix24"]);
    expect(toolProfileToMcpAllowlist("diagnostics")).toEqual(["konoha"]);
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

  test("keeps sandbox profiles separate from runtime adapters", () => {
    expect(listSandboxProfiles().map(p => p.id)).toEqual(["docker", "process", "remote", "tmux"]);
    expect(getSandboxProfile("tmux")?.type).toBe("tmux");
    expect(getSandboxProfile("docker")?.type).toBe("docker");
  });
});
