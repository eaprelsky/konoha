import { describe, expect, test } from "bun:test";
import { isPgReadEnabledFor, resolvePgReadFlags } from "../src/storage/pg-read-flags";

describe("PG_READ staged entity flags", () => {
  test("defaults all Redis-primary entities off", () => {
    const flags = resolvePgReadFlags({});

    expect(flags.legacy_global_enabled).toBe(false);
    expect(flags.enabled_entities).toEqual([]);
    expect(flags.entity_flags).toMatchObject({
      roles: false,
      documents: false,
      workflows: false,
      cases: false,
      work_items: false,
      reminders: false,
    });
  });

  test("supports comma allowlist and explicit entity env flags", () => {
    const env = {
      PG_READ_ENTITIES: "documents,work-items,unknown",
      PG_READ_CASES: "true",
      PG_READ_DOCUMENTS: "false",
    };
    const flags = resolvePgReadFlags(env);

    expect(flags.entity_flags.documents).toBe(false);
    expect(flags.entity_flags.work_items).toBe(true);
    expect(flags.entity_flags.cases).toBe(true);
    expect(flags.enabled_entities).toEqual(["cases", "work_items"]);
  });

  test("keeps legacy PG_READ=true as all-entity fallback with explicit opt-out", () => {
    const env = {
      PG_READ: "true",
      PG_READ_CASES: "false",
    };

    expect(isPgReadEnabledFor("documents", env)).toBe(true);
    expect(isPgReadEnabledFor("cases", env)).toBe(false);
  });
});
