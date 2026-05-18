import { describe, expect, test } from "bun:test";
import { resolveSharedMcpAllowlist } from "../src/agent";
import { SYSTEM_AGENTS } from "../src/routes/admin";

function agent(id: string) {
  const found = SYSTEM_AGENTS.find(item => item.id === id);
  if (!found) throw new Error(`Missing seeded agent ${id}`);
  return found;
}

describe("seeded system agent classifications", () => {
  test("seeded runtime display defaults stay locale-neutral", () => {
    const localized = /[А-Яа-яЁё]/;
    for (const seeded of SYSTEM_AGENTS) {
      expect(seeded.name).not.toMatch(localized);
      expect(seeded.display_alias ?? "").not.toMatch(localized);
    }
  });

  test("every seeded agent has explicit ADR-004 lifecycle metadata", () => {
    for (const seeded of SYSTEM_AGENTS) {
      expect(seeded.seed_classification).toBeDefined();
      expect(seeded.lifecycle_mode).toBeDefined();
    }
  });

  test("telegram runtimes are connector-owned compatibility actors", () => {
    expect(agent("naruto")).toMatchObject({
      seed_classification: "connector_owned",
      lifecycle_mode: "connector_owned",
    });
    expect(agent("sasuke")).toMatchObject({
      seed_classification: "connector_owned",
      lifecycle_mode: "connector_owned",
    });
  });

  test("SDD workers are optional and do not autostart by default", () => {
    for (const id of ["kakashi", "guy", "shino", "hinata"]) {
      const seeded = agent(id);
      expect(seeded.seed_classification).toBe("optional_worker");
      expect(seeded.lifecycle_mode).toBe("optional_on_demand");
      expect(seeded.tags ?? []).toContain("sdd-worker");
      expect(seeded.tags ?? []).not.toContain("autostart");
    }
  });

  test("Kakashi seed cannot revert the Codex runtime profile", () => {
    expect(agent("kakashi")).toMatchObject({
      runtime: "codex",
      fallback_runtime: "claude",
      model: "codex:gpt-5.5",
      llm_client_profile: "codex-gpt-5.5",
      fallback_llm_client_profile: "claude-deepseek-sonnet",
    });
  });

  test("Shikadai reviewer seed cannot revert the Codex runtime profile", () => {
    expect(agent("shikadai")).toMatchObject({
      runtime: "codex",
      fallback_runtime: "claude",
      model: "codex:gpt-5.5",
      llm_client_profile: "codex-gpt-5.5",
      fallback_llm_client_profile: "claude-deepseek-sonnet",
    });
  });

  test("legacy specialist aliases are not required seeded system agents", () => {
    expect(agent("mirai")).toMatchObject({
      seed_classification: "connector_owned",
      lifecycle_mode: "connector_owned",
    });
    expect(agent("mirai").tags ?? []).not.toContain("autostart");

    for (const id of ["jiraiya", "ino", "inojin"]) {
      const seeded = agent(id);
      expect(seeded.seed_classification).toBe("deprecated_compat");
      expect(seeded.lifecycle_mode).toBe("deprecated");
      expect(seeded.tags ?? []).not.toContain("autostart");
    }

    expect(agent("shikadai")).toMatchObject({
      seed_classification: "optional_worker",
      lifecycle_mode: "optional_on_demand",
    });
  });

  test("Jiraiya corporate-memory experiment is retired by default", () => {
    const seeded = agent("jiraiya");
    const corporateMemoryMcp = new Set(["yonote", "memory", "mempalace"]);

    expect(seeded.seed_classification).toBe("deprecated_compat");
    expect(seeded.lifecycle_mode).toBe("deprecated");
    expect(seeded.tool_profile).toBe("default");
    expect(seeded.capabilities ?? []).toEqual(["deprecated-compat"]);
    expect(resolveSharedMcpAllowlist(seeded.shared_mcp_allowlist, seeded.tool_profile)).toEqual(["konoha"]);
    expect((seeded.shared_mcp_allowlist ?? []).some(server => corporateMemoryMcp.has(server))).toBe(false);
  });

  test("system monitor is optional but may be enabled for this deployment", () => {
    expect(agent("kiba")).toMatchObject({
      name: "System monitor",
      seed_classification: "optional_worker",
      lifecycle_mode: "optional_on_demand",
      tool_profile: "kiba-monitor-core",
    });
  });

  test("Kiba default MCP surface is bounded to Konoha monitoring actions", () => {
    const seeded = agent("kiba");
    const nonMonitoringMcp = new Set([
      "gitlab",
      "yonote",
      "yandex-tracker",
      "miro",
      "miro-api",
      "excel",
      "word",
      "google-docs",
      "google-sheets",
      "puppeteer",
      "memory",
      "mempalace",
      "caldav",
      "openrouter-audio",
      "email",
      "bitrix24",
      "telethon-channel",
    ]);

    expect(resolveSharedMcpAllowlist(seeded.shared_mcp_allowlist, seeded.tool_profile)).toEqual(["konoha"]);
    expect((seeded.shared_mcp_allowlist ?? []).some(server => nonMonitoringMcp.has(server))).toBe(false);
    expect(seeded.capabilities ?? []).toEqual(["konoha-lite", "health-check", "alert", "diagnose", "escalate"]);
  });

  test("konoha-lite capability is wired for target agents, not for Naruto", () => {
    const liteAgents = ["kakashi", "shino", "shikadai", "sasuke", "kiba"];
    for (const id of liteAgents) {
      const caps = agent(id).capabilities ?? [];
      expect(caps).toContain("konoha-lite");
    }
    // Naruto stays full profile — needs konoha_agents
    const narutoCaps = agent("naruto").capabilities ?? [];
    expect(narutoCaps).not.toContain("konoha-lite");
  });

  test("monitoring and connector agents do not start browser MCP by default", () => {
    const browserMcpServers = new Set(["puppeteer", "playwright", "browser"]);
    const alwaysOnNonQa = ["naruto", "sasuke", "kiba", "kakashi"];

    for (const id of alwaysOnNonQa) {
      const seeded = agent(id);
      expect(seeded.tool_profile).not.toBe("browser-debug-ttl");
      expect(seeded.tool_profile).not.toBe("full");
      expect((seeded.shared_mcp_allowlist ?? []).some(server => browserMcpServers.has(server))).toBe(false);
      expect(seeded.capabilities ?? []).not.toContain("testbench");
    }
  });

  test("always-on agents do not start Office, Miro, or spreadsheet MCP by default", () => {
    const officeMiroSpreadsheet = new Set(["excel", "word", "google-docs", "google-sheets", "miro", "miro-api"]);
    const alwaysOnNonOffice = ["naruto", "sasuke", "kiba", "kakashi", "shikadai"];

    for (const id of alwaysOnNonOffice) {
      const seeded = agent(id);
      expect(seeded.tool_profile).not.toBe("office-miro-debug-ttl");
      expect(seeded.tool_profile).not.toBe("full");
      expect((seeded.shared_mcp_allowlist ?? []).some(server => officeMiroSpreadsheet.has(server))).toBe(false);
    }
  });

  test("always-on agents do not carry retired Mempalace MCP", () => {
    const alwaysOnAgents = ["naruto", "sasuke", "kiba", "kakashi", "shikadai"];

    for (const id of alwaysOnAgents) {
      const seeded = agent(id);
      expect(seeded.tool_profile).not.toBe("full");
      expect(seeded.shared_mcp_allowlist ?? []).not.toContain("mempalace");
    }
  });

  test("QA browser checks route through bounded TestBench by default", () => {
    expect(agent("hinata").capabilities ?? []).toContain("testbench");
    expect(agent("hinata").tool_profile).not.toBe("browser-debug-ttl");
  });
});
