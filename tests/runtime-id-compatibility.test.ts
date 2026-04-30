import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { findRuntimeIdProductLeaks } from "../scripts/check-runtime-id-product-leaks";
import { SYSTEM_AGENTS } from "../src/routes/admin";

interface RuntimeIdMap {
  schema_version: number;
  agents: Array<{
    runtime_id: string;
    product_role_key: string;
    canonical_name: string;
    display_alias: string;
    service_name: string;
    tmux_session: string;
    connector_role: string;
    allowed_internal_surfaces: string[];
  }>;
}

const mapPath = join(import.meta.dir, "..", "docs", "runtime-id-compatibility-map.json");

function loadMap(): RuntimeIdMap {
  return JSON.parse(readFileSync(mapPath, "utf-8")) as RuntimeIdMap;
}

describe("runtime id compatibility map", () => {
  test("defines required migration fields for every runtime id", () => {
    const map = loadMap();
    expect(map.schema_version).toBe(1);

    const ids = new Set<string>();
    for (const agent of map.agents) {
      expect(agent.runtime_id).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(ids.has(agent.runtime_id)).toBe(false);
      ids.add(agent.runtime_id);
      expect(agent.product_role_key.length).toBeGreaterThan(2);
      expect(agent.canonical_name.length).toBeGreaterThan(2);
      expect(agent.display_alias.length).toBeGreaterThan(1);
      expect(agent.service_name.length).toBeGreaterThan(2);
      expect(agent.tmux_session.length).toBeGreaterThan(1);
      expect(agent.connector_role.length).toBeGreaterThan(2);
      expect(agent.allowed_internal_surfaces.length).toBeGreaterThan(0);
    }
  });

  test("keeps map display values locale-neutral", () => {
    const localized = /[А-Яа-яЁё]/;
    for (const agent of loadMap().agents) {
      expect(agent.canonical_name).not.toMatch(localized);
      expect(agent.display_alias).not.toMatch(localized);
    }
  });

  test("covers every seeded system agent runtime id", () => {
    const mapped = new Set(loadMap().agents.map(agent => agent.runtime_id));
    for (const seeded of SYSTEM_AGENTS) {
      expect(mapped.has(seeded.id)).toBe(true);
    }
  });

  test("keeps product surface runtime id leaks explicit and allowlisted", () => {
    expect(findRuntimeIdProductLeaks()).toEqual([]);
  });

  test("detects new product-surface runtime id leaks", () => {
    const leaks = findRuntimeIdProductLeaks(["naruto"], ["docs/agent-naming.md"]);
    expect(leaks.some(leak => leak.id === "naruto")).toBe(true);
  });
});
