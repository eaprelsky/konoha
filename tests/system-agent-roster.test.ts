import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { SYSTEM_AGENTS } from "../src/routes/admin";

interface RosterAgent {
  id: string;
  seed_classification: string;
  lifecycle_mode: string;
  launch_strategy: string;
  owner: string;
  mcp_allowlist: string[];
  resource_budget: string;
  systemd: {
    unit: string;
    slice: string;
  };
  tmux_session: string;
  watchdog: {
    service: string;
    route: string;
  };
  health_policy: string;
  kiba_monitor: string;
  paused_semantics: string;
}

interface Roster {
  schema_version: number;
  updated_for_issue: number;
  agents: RosterAgent[];
}

const repoRoot = join(import.meta.dir, "..");
const rosterPath = join(repoRoot, "docs", "system-agent-roster.json");

function loadRoster(): Roster {
  return JSON.parse(readFileSync(rosterPath, "utf-8")) as Roster;
}

function rosterById(): Map<string, RosterAgent> {
  return new Map(loadRoster().agents.map(agent => [agent.id, agent]));
}

function unitFileFor(unit: string): string | null {
  if (unit === "none") return null;
  if (unit === "konoha.service") return null;
  if (unit.startsWith("agent-managed@")) return "agent-managed@.service";
  return unit;
}

function sorted(items: string[]): string[] {
  return [...items].sort((a, b) => a.localeCompare(b));
}

describe("canonical system agent roster", () => {
  test("covers issue #790 required runtime ids", () => {
    const required = [
      "naruto",
      "sasuke",
      "kiba",
      "kakashi",
      "guy",
      "shino",
      "hinata",
      "mirai",
      "shikadai",
      "ibiki",
      "ino",
      "inojin",
      "itachi",
      "akamaru",
      "jiraiya",
    ];
    const ids = new Set(loadRoster().agents.map(agent => agent.id));

    expect(loadRoster().schema_version).toBe(1);
    expect(loadRoster().updated_for_issue).toBe(790);
    for (const id of required) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test("every row defines lifecycle, launch, ownership, resources, watchdog, Kiba, and pause policy", () => {
    for (const agent of loadRoster().agents) {
      expect(agent.id).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(agent.seed_classification.length).toBeGreaterThan(2);
      expect(agent.lifecycle_mode.length).toBeGreaterThan(2);
      expect(agent.launch_strategy.length).toBeGreaterThan(2);
      expect(agent.owner.length).toBeGreaterThan(2);
      expect(Array.isArray(agent.mcp_allowlist)).toBe(true);
      expect(agent.resource_budget.length).toBeGreaterThan(2);
      expect(agent.systemd.unit.length).toBeGreaterThan(2);
      expect(agent.systemd.slice.length).toBeGreaterThan(2);
      expect(agent.tmux_session.length).toBeGreaterThan(1);
      expect(agent.watchdog.service.length).toBeGreaterThan(2);
      expect(agent.watchdog.route.length).toBeGreaterThan(2);
      expect(agent.health_policy.length).toBeGreaterThan(2);
      expect(agent.kiba_monitor.length).toBeGreaterThan(1);
      expect(agent.paused_semantics.length).toBeGreaterThan(10);
    }
  });

  test("seeded AgentDef metadata agrees with canonical roster", () => {
    const roster = rosterById();
    for (const seeded of SYSTEM_AGENTS) {
      const agent = roster.get(seeded.id);
      expect(agent).toBeDefined();
      expect(agent?.seed_classification).toBe(seeded.seed_classification);
      expect(agent?.lifecycle_mode).toBe(seeded.lifecycle_mode);
      expect(agent?.launch_strategy).toBe(seeded.launch_strategy);
      expect(agent?.tmux_session).toBe(seeded.tmux_session_override);
      expect(sorted(agent?.mcp_allowlist ?? [])).toEqual(sorted(seeded.shared_mcp_allowlist ?? []));
    }
  });

  test("lifecycle watchdog WATCHDOG_AGENTS matches roster lifecycle scope", () => {
    const unit = readFileSync(join(repoRoot, "systemd", "agent-watchdog-lifecycle.service"), "utf-8");
    const match = unit.match(/^Environment=WATCHDOG_AGENTS=([^\n]+)$/m);
    expect(match).not.toBeNull();
    const fromUnit = sorted((match?.[1] ?? "").split(",").filter(Boolean));
    const fromRoster = sorted(loadRoster().agents
      .filter(agent => agent.watchdog.service === "agent-watchdog-lifecycle.service")
      .map(agent => agent.id));

    expect(fromUnit).toEqual(fromRoster);
  });

  test("systemd unit references in roster point at committed compatibility units", () => {
    for (const agent of loadRoster().agents) {
      const unit = unitFileFor(agent.systemd.unit);
      if (!unit) continue;
      expect(existsSync(join(repoRoot, "systemd", unit))).toBe(true);
    }
  });

  test("operator README points at the canonical roster", () => {
    const readme = readFileSync(join(repoRoot, "agents", "README.md"), "utf-8");
    expect(readme).toContain("docs/system-agent-roster.md");
    expect(readme).not.toContain("Guy](guy/AGENTS.md) | Haiku | Optional helper");
    expect(readme).not.toContain("Jiraiya](jiraiya/AGENTS.md) | Sonnet | Chronicler");
  });

  test("Akamaru service checks cover default monitored dedicated units", () => {
    const akamaru = readFileSync(join(repoRoot, "scripts", "akamaru.py"), "utf-8");
    const defaultMonitored = loadRoster().agents
      .filter(agent => agent.kiba_monitor === "default")
      .flatMap(agent => [agent.systemd.unit, agent.watchdog.service])
      .filter(unit => unit.endsWith(".service"))
      .filter(unit => !unit.startsWith("agent-managed@"))
      .filter(unit => unit !== "konoha.service")
      .filter(unit => !unit.startsWith("agent-naruto") && !unit.startsWith("agent-sasuke"));

    for (const unit of new Set(defaultMonitored)) {
      expect(akamaru).toContain(`"${unit}"`);
    }
  });
});
