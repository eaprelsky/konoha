import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { redis } from "./redis";
import type { AgentDef } from "./agent/types";

export type DisplayEntityType = "agent" | "role" | "workflow" | "ui_badge";
export type DisplayField = "name" | "alias" | "label" | "description";
export type DisplaySource = "org_override" | "locale_catalog" | "neutral_default";

export interface DisplayCatalogEntry {
  scope: string;
  entity_type: DisplayEntityType;
  entity_id: string;
  locale: string;
  field: DisplayField;
  value: string;
  updated_at: string;
}

export interface ResolvedDisplayField {
  value: string;
  source: DisplaySource;
  locale: string;
}

export interface AgentDisplayProjection {
  name: string;
  alias?: string;
  locale: string;
  source: {
    name: DisplaySource;
    alias?: DisplaySource;
  };
}

export const DISPLAY_CATALOG_KEY = "konoha:display-catalog";
export const DEFAULT_ORG_SCOPE = `org:${process.env.KONOHA_ORG_ID || "default"}`;
export const LOCALE_SCOPE = "locale";
export const NEUTRAL_LOCALE = "neutral";
export const DEFAULT_LOCALE = "en";
export const DISPLAY_CATALOG_DIR = process.env.KONOHA_DISPLAY_CATALOG_DIR
  || join(import.meta.dir, "..", "runtime-config");

const now = "1970-01-01T00:00:00.000Z";

export function loadLocaleCatalogEntries(dir = DISPLAY_CATALOG_DIR): DisplayCatalogEntry[] {
  if (!existsSync(dir)) return [];
  const entries: DisplayCatalogEntry[] = [];
  for (const filename of readdirSync(dir).sort()) {
    if (!filename.startsWith("display-catalog.") || !filename.endsWith(".json")) continue;
    const file = join(dir, filename);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const rawEntries = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { entries?: unknown }).entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
    for (const raw of rawEntries) {
      const entry = normalizeCatalogEntry(raw);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function normalizeCatalogEntry(raw: unknown): DisplayCatalogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Partial<DisplayCatalogEntry>;
  if (
    typeof entry.scope !== "string"
    || typeof entry.entity_type !== "string"
    || typeof entry.entity_id !== "string"
    || typeof entry.locale !== "string"
    || typeof entry.field !== "string"
    || typeof entry.value !== "string"
  ) {
    return null;
  }
  return {
    scope: entry.scope,
    entity_type: entry.entity_type as DisplayEntityType,
    entity_id: entry.entity_id,
    locale: entry.locale,
    field: entry.field as DisplayField,
    value: entry.value,
    updated_at: typeof entry.updated_at === "string" ? entry.updated_at : now,
  };
}

export function displayCatalogStorageKey(entry: Omit<DisplayCatalogEntry, "value" | "updated_at">): string {
  return [
    entry.scope,
    entry.entity_type,
    entry.entity_id,
    entry.locale,
    entry.field,
  ].join("|");
}

export function parseDisplayCatalogStorageKey(key: string, value: string): DisplayCatalogEntry | null {
  const [scope, entityType, entityId, locale, field] = key.split("|");
  if (!scope || !entityType || !entityId || !locale || !field) return null;
  let parsed: Pick<DisplayCatalogEntry, "value" | "updated_at">;
  try {
    parsed = JSON.parse(value) as Pick<DisplayCatalogEntry, "value" | "updated_at">;
  } catch {
    return null;
  }
  if (typeof parsed.value !== "string" || typeof parsed.updated_at !== "string") return null;
  return {
    scope,
    entity_type: entityType as DisplayEntityType,
    entity_id: entityId,
    locale,
    field: field as DisplayField,
    value: parsed.value,
    updated_at: parsed.updated_at,
  };
}

export async function putDisplayCatalogEntry(entry: DisplayCatalogEntry): Promise<void> {
  const key = displayCatalogStorageKey(entry);
  await redis.hset(DISPLAY_CATALOG_KEY, key, JSON.stringify({
    value: entry.value,
    updated_at: entry.updated_at,
  }));
}

export async function listStoredDisplayCatalogEntries(): Promise<DisplayCatalogEntry[]> {
  const raw = await redis.hgetall(DISPLAY_CATALOG_KEY);
  return Object.entries(raw)
    .map(([key, value]) => parseDisplayCatalogStorageKey(key, value))
    .filter((entry): entry is DisplayCatalogEntry => Boolean(entry));
}

export async function listDisplayCatalogEntries(filter: {
  scope?: string;
  entity_type?: DisplayEntityType;
  entity_id?: string;
  locale?: string;
  field?: DisplayField;
} = {}): Promise<DisplayCatalogEntry[]> {
  const entries = [...loadLocaleCatalogEntries(), ...await listStoredDisplayCatalogEntries()];
  return entries
    .filter(entry => !filter.scope || entry.scope === filter.scope)
    .filter(entry => !filter.entity_type || entry.entity_type === filter.entity_type)
    .filter(entry => !filter.entity_id || entry.entity_id === filter.entity_id)
    .filter(entry => !filter.locale || entry.locale === filter.locale)
    .filter(entry => !filter.field || entry.field === filter.field)
    .sort((a, b) =>
      a.scope.localeCompare(b.scope)
      || a.entity_type.localeCompare(b.entity_type)
      || a.entity_id.localeCompare(b.entity_id)
      || a.locale.localeCompare(b.locale)
      || a.field.localeCompare(b.field)
    );
}

export function resolveDisplayValue(
  entries: DisplayCatalogEntry[],
  input: {
    org_scope?: string;
    locale?: string;
    entity_type: DisplayEntityType;
    entity_id: string;
    field: DisplayField;
    neutral_default: string;
  },
): ResolvedDisplayField {
  const locale = normalizeLocale(input.locale);
  const orgScope = input.org_scope || DEFAULT_ORG_SCOPE;
  const match = (scope: string, matchLocale: string) => entries.find(entry =>
    entry.scope === scope
    && entry.entity_type === input.entity_type
    && entry.entity_id === input.entity_id
    && entry.locale === matchLocale
    && entry.field === input.field
  );

  const orgOverride = match(orgScope, locale) ?? match(orgScope, NEUTRAL_LOCALE);
  if (orgOverride) return { value: orgOverride.value, source: "org_override", locale: orgOverride.locale };

  const localeValue = match(LOCALE_SCOPE, locale);
  if (localeValue) return { value: localeValue.value, source: "locale_catalog", locale: localeValue.locale };

  return { value: input.neutral_default, source: "neutral_default", locale: NEUTRAL_LOCALE };
}

export async function resolveAgentDisplay(
  def: Pick<AgentDef, "id" | "name" | "display_alias">,
  options: { locale?: string; org_scope?: string } = {},
): Promise<AgentDisplayProjection> {
  const entries = await listDisplayCatalogEntries({
    entity_type: "agent",
    entity_id: def.id,
  });
  const name = resolveDisplayValue(entries, {
    org_scope: options.org_scope,
    locale: options.locale,
    entity_type: "agent",
    entity_id: def.id,
    field: "name",
    neutral_default: def.name,
  });
  const aliasDefault = def.display_alias ?? def.name;
  const alias = resolveDisplayValue(entries, {
    org_scope: options.org_scope,
    locale: options.locale,
    entity_type: "agent",
    entity_id: def.id,
    field: "alias",
    neutral_default: aliasDefault,
  });

  return {
    name: name.value,
    alias: alias.value,
    locale: normalizeLocale(options.locale),
    source: {
      name: name.source,
      alias: alias.source,
    },
  };
}

function normalizeLocale(locale: string | undefined): string {
  const requested = (locale || DEFAULT_LOCALE).split(",")[0].split(";")[0].trim().toLowerCase();
  return requested.split("-")[0] || DEFAULT_LOCALE;
}
