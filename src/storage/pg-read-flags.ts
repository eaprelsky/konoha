export type PgReadEntity = "roles" | "documents" | "workflows" | "cases" | "work_items" | "reminders";

export const PG_READ_ENTITIES: PgReadEntity[] = [
  "roles",
  "documents",
  "workflows",
  "cases",
  "work_items",
  "reminders",
];

const ENTITY_FLAG_ENV: Record<PgReadEntity, string> = {
  roles: "PG_READ_ROLES",
  documents: "PG_READ_DOCUMENTS",
  workflows: "PG_READ_WORKFLOWS",
  cases: "PG_READ_CASES",
  work_items: "PG_READ_WORK_ITEMS",
  reminders: "PG_READ_REMINDERS",
};

function readBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return false;
}

function normalizeEntity(value: string): PgReadEntity | null {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "workitems") return "work_items";
  if ((PG_READ_ENTITIES as string[]).includes(normalized)) return normalized as PgReadEntity;
  return null;
}

function parseEntityList(value: string | undefined): Set<PgReadEntity> {
  const result = new Set<PgReadEntity>();
  if (!value) return result;
  for (const part of value.split(",")) {
    const entity = normalizeEntity(part);
    if (entity) result.add(entity);
  }
  return result;
}

function readEntityOverride(entity: PgReadEntity, env: NodeJS.ProcessEnv): boolean | undefined {
  const envName = ENTITY_FLAG_ENV[entity];
  const explicit = readBool(env[envName]);
  if (explicit !== undefined) return explicit;
  return readBool(env[`KONOHA_${envName}`]);
}

export interface PgReadFlagConfig {
  legacy_global_enabled: boolean;
  enabled_entities: PgReadEntity[];
  entity_flags: Record<PgReadEntity, boolean>;
}

export function resolvePgReadFlags(env: NodeJS.ProcessEnv = process.env): PgReadFlagConfig {
  const legacyGlobal = readBool(env.PG_READ) === true;
  const configuredEntities = parseEntityList(env.PG_READ_ENTITIES || env.KONOHA_PG_READ_ENTITIES);
  const entityFlags = {} as Record<PgReadEntity, boolean>;

  for (const entity of PG_READ_ENTITIES) {
    const override = readEntityOverride(entity, env);
    entityFlags[entity] = override ?? (configuredEntities.has(entity) || legacyGlobal);
  }

  return {
    legacy_global_enabled: legacyGlobal,
    enabled_entities: PG_READ_ENTITIES.filter(entity => entityFlags[entity]),
    entity_flags: entityFlags,
  };
}

export function isPgReadEnabledFor(entity: PgReadEntity, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePgReadFlags(env).entity_flags[entity];
}
