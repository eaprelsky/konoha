import { afterAll, describe, expect, test } from "bun:test";
import { redis } from "../src/redis";
import {
  DISPLAY_CATALOG_KEY,
  displayCatalogStorageKey,
  listDisplayCatalogEntries,
  putDisplayCatalogEntry,
  resolveAgentDisplay,
  resolveDisplayValue,
  type DisplayCatalogEntry,
} from "../src/display-catalog";

const RUN = `t${Date.now()}`;
const orgScope = `org:${RUN}`;
const orgEntry: DisplayCatalogEntry = {
  scope: orgScope,
  entity_type: "agent",
  entity_id: `agent-${RUN}`,
  locale: "ru",
  field: "name",
  value: "Орг-воркер",
  updated_at: new Date().toISOString(),
};

afterAll(async () => {
  await redis.hdel(DISPLAY_CATALOG_KEY, displayCatalogStorageKey(orgEntry));
});

describe("display catalog resolver", () => {
  test("prefers org override over locale catalog over neutral default", () => {
    const entries: DisplayCatalogEntry[] = [
      {
        scope: "locale",
        entity_type: "agent",
        entity_id: "kakashi",
        locale: "ru",
        field: "name",
        value: "Локализованный тимлид",
        updated_at: "2026-04-30T00:00:00.000Z",
      },
      {
        scope: "org:acme",
        entity_type: "agent",
        entity_id: "kakashi",
        locale: "ru",
        field: "name",
        value: "ACME lead worker",
        updated_at: "2026-04-30T00:00:00.000Z",
      },
    ];

    expect(resolveDisplayValue(entries, {
      org_scope: "org:acme",
      locale: "ru",
      entity_type: "agent",
      entity_id: "kakashi",
      field: "name",
      neutral_default: "SDD lead",
    })).toMatchObject({ value: "ACME lead worker", source: "org_override" });

    expect(resolveDisplayValue(entries, {
      org_scope: "org:other",
      locale: "ru",
      entity_type: "agent",
      entity_id: "kakashi",
      field: "name",
      neutral_default: "SDD lead",
    })).toMatchObject({ value: "Локализованный тимлид", source: "locale_catalog" });

    expect(resolveDisplayValue(entries, {
      org_scope: "org:other",
      locale: "en",
      entity_type: "agent",
      entity_id: "kakashi",
      field: "name",
      neutral_default: "SDD lead",
    })).toMatchObject({ value: "SDD lead", source: "neutral_default" });
  });

  test("stores org-scoped entries using the display_catalog shape", async () => {
    await putDisplayCatalogEntry(orgEntry);
    const entries = await listDisplayCatalogEntries({
      scope: orgScope,
      entity_type: "agent",
      entity_id: orgEntry.entity_id,
      locale: "ru",
      field: "name",
    });

    expect(entries).toEqual([orgEntry]);
  });

  test("resolves agent display without changing runtime identity", async () => {
    await putDisplayCatalogEntry(orgEntry);
    const def = {
      id: orgEntry.entity_id,
      name: "Neutral worker",
      display_alias: "Neutral alias",
    };
    const display = await resolveAgentDisplay(def, { locale: "ru", org_scope: orgScope });

    expect(def.id).toBe(orgEntry.entity_id);
    expect(def.name).toBe("Neutral worker");
    expect(display).toMatchObject({
      name: "Орг-воркер",
      locale: "ru",
      source: { name: "org_override" },
    });
  });
});
