import { describe, expect, test } from "bun:test";
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

  test("system monitor is optional but may be enabled for this deployment", () => {
    expect(agent("kiba")).toMatchObject({
      name: "System monitor",
      seed_classification: "optional_worker",
      lifecycle_mode: "optional_on_demand",
    });
  });
});
