#!/usr/bin/env bun
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import Redis from "ioredis";
import postgres from "postgres";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CONTRACT_PATH = resolve(REPO_ROOT, "docs/staging-environment.json");

export interface StagingContract {
  schema_version: number;
  environment: string;
  service_profile: string;
  env_template: string;
  deployed_env_file: string;
  ports: {
    konoha_port: number;
    konoha_url: string;
    konoha_staging_url_env: string;
    forbidden_ports: number[];
  };
  storage: {
    redis: {
      env: string;
      db: number;
      forbidden_db: number;
      reset_patterns: string[];
      forbidden_commands: string[];
    };
    postgres: {
      runtime_env: string;
      staging_database_url_env: string;
      database_name: string;
      schema: string;
      forbidden_schema: string;
      schema_sql: string;
      reset_tables: string[];
    };
  };
  connectors: {
    enabled_by_default: string[];
    disabled_by_default: string[];
    external_enable_waiver_env: string;
    external_enable_waiver_required: boolean;
  };
  agents: {
    village_id: string;
    id_prefix: string;
    workdir_root: string;
    allowed_agent_ids: string[];
    forbidden_production_ids: string[];
  };
  smoke: {
    health_paths: string[];
    requires: string[];
  };
}

export interface StagingValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  env: Record<string, string>;
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command = "check", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) env[key] = value;
  }
  return env;
}

export function loadStagingContract(path = CONTRACT_PATH): StagingContract {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (raw.schema_version !== 1) throw new Error(`Unsupported staging contract schema_version=${raw.schema_version}`);
  return raw as StagingContract;
}

function defaultDatabaseUrl(contract: StagingContract): string {
  const schema = encodeURIComponent(`-c search_path=${contract.storage.postgres.schema},public`);
  return `postgres://127.0.0.1:5432/${contract.storage.postgres.database_name}?options=${schema}`;
}

export function stagingDefaults(contract = loadStagingContract()): Record<string, string> {
  const databaseUrl = defaultDatabaseUrl(contract);
  return {
    KONOHA_ENV: contract.environment,
    KONOHA_SERVICE_PROFILE: contract.service_profile,
    KONOHA_PORT: String(contract.ports.konoha_port),
    KONOHA_URL: contract.ports.konoha_url,
    [contract.ports.konoha_staging_url_env]: contract.ports.konoha_url,
    KONOHA_PUBLIC_URL: contract.ports.konoha_url,
    [contract.storage.redis.env]: String(contract.storage.redis.db),
    [contract.storage.postgres.staging_database_url_env]: databaseUrl,
    [contract.storage.postgres.runtime_env]: databaseUrl,
    KONOHA_SETUP_FILE: "/opt/shared/.konoha-setup.staging.json",
    KONOHA_DASHBOARD_AUTH_FILE: "/opt/shared/.dashboard-auth.staging.json",
    KONOHA_AGENT_WORKDIR_ROOT: contract.agents.workdir_root,
    KONOHA_VILLAGE_ID: contract.agents.village_id,
    KONOHA_ENABLED_CONNECTORS: contract.connectors.enabled_by_default.join(","),
    KONOHA_HEALTH_ENABLED_CONNECTORS: contract.connectors.enabled_by_default.join(","),
    KONOHA_ENABLED_OPTIONAL_MONITORS: "akamaru",
    KIBA_MONITOR_ENVIRONMENT: contract.environment,
  };
}

function normalizeUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function databaseUrlUsesStaging(url: URL | null, contract: StagingContract): boolean {
  if (!url) return false;
  const dbName = url.pathname.replace(/^\//, "");
  const options = url.searchParams.get("options") || "";
  return dbName.includes("staging") && options.includes(`search_path=${contract.storage.postgres.schema},public`);
}

export function validateStagingEnv(
  env: Record<string, string | undefined> = process.env,
  contract = loadStagingContract(),
): StagingValidation {
  const merged = { ...stagingDefaults(contract), ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) } as Record<string, string>;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (merged.KONOHA_ENV !== contract.environment) errors.push(`KONOHA_ENV must be ${contract.environment}`);
  if (merged.KONOHA_SERVICE_PROFILE !== contract.service_profile) errors.push(`KONOHA_SERVICE_PROFILE must be ${contract.service_profile}`);

  const port = Number(merged.KONOHA_PORT);
  if (port !== contract.ports.konoha_port) errors.push(`KONOHA_PORT must be ${contract.ports.konoha_port}`);
  if (contract.ports.forbidden_ports.includes(port)) errors.push(`KONOHA_PORT must not use reserved port ${port}`);

  const stagingUrl = normalizeUrl(merged[contract.ports.konoha_staging_url_env]);
  const konohaUrl = normalizeUrl(merged.KONOHA_URL);
  if (!stagingUrl) errors.push(`${contract.ports.konoha_staging_url_env} must be a valid URL`);
  if (!konohaUrl) errors.push("KONOHA_URL must be a valid URL");
  if (stagingUrl && Number(stagingUrl.port || (stagingUrl.protocol === "https:" ? 443 : 80)) !== contract.ports.konoha_port) {
    errors.push(`${contract.ports.konoha_staging_url_env} must point at port ${contract.ports.konoha_port}`);
  }
  if (konohaUrl && stagingUrl && konohaUrl.toString().replace(/\/$/, "") !== stagingUrl.toString().replace(/\/$/, "")) {
    errors.push("KONOHA_URL must equal KONOHA_STAGING_URL for staging service commands");
  }
  if ([konohaUrl, stagingUrl].some(url => url?.hostname.includes("agent.eaprelsky.ru"))) {
    errors.push("staging URLs must not point at production agent.eaprelsky.ru");
  }

  const redisDb = Number(merged[contract.storage.redis.env]);
  if (!Number.isInteger(redisDb) || redisDb <= 0) errors.push("REDIS_DB must be a non-zero staging DB");
  if (redisDb === contract.storage.redis.forbidden_db) errors.push("REDIS_DB must not be production DB 0");

  const stagingDatabaseUrl = merged[contract.storage.postgres.staging_database_url_env];
  const runtimeDatabaseUrl = merged[contract.storage.postgres.runtime_env];
  const stagingDbUrl = normalizeUrl(stagingDatabaseUrl);
  const runtimeDbUrl = normalizeUrl(runtimeDatabaseUrl);
  if (!databaseUrlUsesStaging(stagingDbUrl, contract)) errors.push("STAGING_DATABASE_URL must use the staging database and staging search_path");
  if (!databaseUrlUsesStaging(runtimeDbUrl, contract)) errors.push("DATABASE_URL must use the staging database and staging search_path");
  if (runtimeDatabaseUrl !== stagingDatabaseUrl) errors.push("DATABASE_URL must equal STAGING_DATABASE_URL for staging");
  if ((runtimeDbUrl?.searchParams.get("options") || "").includes(`search_path=${contract.storage.postgres.forbidden_schema}`)) {
    errors.push("DATABASE_URL must not use PostgreSQL public schema as the first search_path entry");
  }

  const enabledConnectors = [
    merged.KONOHA_ENABLED_CONNECTORS || "",
    merged.KONOHA_HEALTH_ENABLED_CONNECTORS || "",
  ]
    .flatMap(value => value.split(","))
    .map(item => item.trim())
    .filter(Boolean);
  if (enabledConnectors.length > 0 && !merged[contract.connectors.external_enable_waiver_env]) {
    errors.push(`external connectors require ${contract.connectors.external_enable_waiver_env}`);
  }

  if (!merged.KONOHA_AGENT_WORKDIR_ROOT?.includes("staging")) errors.push("KONOHA_AGENT_WORKDIR_ROOT must be staging-specific");
  if (merged.KONOHA_VILLAGE_ID !== contract.agents.village_id) errors.push(`KONOHA_VILLAGE_ID must be ${contract.agents.village_id}`);
  if (!merged.KONOHA_TOKEN) warnings.push("KONOHA_TOKEN is empty; live smoke can only use unauthenticated endpoints");

  return { ok: errors.length === 0, errors, warnings, env: merged };
}

export function buildResetPlan(contract = loadStagingContract()): { redis: string[]; postgres: string[]; forbidden: string[] } {
  return {
    redis: contract.storage.redis.reset_patterns,
    postgres: contract.storage.postgres.reset_tables,
    forbidden: [
      ...contract.storage.redis.forbidden_commands,
      "DROP DATABASE",
      `search_path=${contract.storage.postgres.forbidden_schema}`,
      "REDIS_DB=0",
    ],
  };
}

function printExports(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    console.log(`export ${key}=${JSON.stringify(value)}`);
  }
}

async function httpSmoke(env: Record<string, string>, contract: StagingContract): Promise<void> {
  const base = env[contract.ports.konoha_staging_url_env].replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (env.KONOHA_TOKEN) headers.Authorization = `Bearer ${env.KONOHA_TOKEN}`;
  for (const path of contract.smoke.health_paths) {
    const response = await fetch(`${base}${path}`, { headers });
    if (!response.ok) throw new Error(`staging smoke ${path} failed with HTTP ${response.status}`);
  }
}

async function applyInit(env: Record<string, string>, contract: StagingContract): Promise<void> {
  const sql = postgres(env[contract.storage.postgres.runtime_env], { max: 1, idle_timeout: 5, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql(contract.storage.postgres.schema)}`;
    await sql`SET search_path TO ${sql(contract.storage.postgres.schema)}, public`;
    const schemaSql = readFileSync(resolve(REPO_ROOT, contract.storage.postgres.schema_sql), "utf-8")
      .replace(/^CREATE EXTENSION IF NOT EXISTS "uuid-ossp";\s*$/m, "");
    await sql.unsafe(schemaSql);
  } finally {
    await sql.end();
  }
}

async function applyReset(env: Record<string, string>, contract: StagingContract): Promise<void> {
  const redis = new Redis({ host: "127.0.0.1", port: 6379, db: Number(env[contract.storage.redis.env]), lazyConnect: false });
  const sql = postgres(env[contract.storage.postgres.runtime_env], { max: 1, idle_timeout: 5, connect_timeout: 5, onnotice: () => {} });
  try {
    const keys = new Set<string>();
    for (const pattern of contract.storage.redis.reset_patterns) {
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
        cursor = next;
        for (const key of batch) keys.add(key);
      } while (cursor !== "0");
    }
    if (keys.size > 0) await redis.del(...keys);
    await sql`SET search_path TO ${sql(contract.storage.postgres.schema)}, public`;
    for (const table of contract.storage.postgres.reset_tables) {
      await sql.unsafe(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
    }
  } finally {
    redis.disconnect();
    await sql.end();
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const contract = loadStagingContract();
  const fileEnv = typeof flags["env-file"] === "string" ? parseEnvFile(resolve(REPO_ROOT, flags["env-file"])) : {};
  const validation = validateStagingEnv({ ...process.env, ...fileEnv }, contract);
  const json = Boolean(flags.json);

  if (command === "env") {
    printExports(stagingDefaults(contract));
    return;
  }

  if (command === "check") {
    if (json) console.log(JSON.stringify(validation, null, 2));
    else {
      console.log(validation.ok ? "staging environment: OK" : "staging environment: FAIL");
      for (const error of validation.errors) console.error(`ERROR: ${error}`);
      for (const warning of validation.warnings) console.warn(`WARN: ${warning}`);
    }
    process.exit(validation.ok ? 0 : 1);
  }

  if (!validation.ok) {
    for (const error of validation.errors) console.error(`ERROR: ${error}`);
    process.exit(1);
  }

  if (command === "smoke") {
    const dryRun = flags["dry-run"] || !flags.live;
    console.log(JSON.stringify({ dry_run: Boolean(dryRun), reset_plan: buildResetPlan(contract), health_paths: contract.smoke.health_paths }, null, 2));
    if (!dryRun) await httpSmoke(validation.env, contract);
    return;
  }

  if (command === "init") {
    if (flags["dry-run"]) {
      console.log(JSON.stringify({ dry_run: true, schema: contract.storage.postgres.schema, schema_sql: contract.storage.postgres.schema_sql }, null, 2));
      return;
    }
    await applyInit(validation.env, contract);
    console.log(`staging schema initialized: ${contract.storage.postgres.schema}`);
    return;
  }

  if (command === "reset") {
    const plan = buildResetPlan(contract);
    if (!flags.apply) {
      console.log(JSON.stringify({ dry_run: true, ...plan }, null, 2));
      return;
    }
    await applyReset(validation.env, contract);
    console.log("staging reset applied");
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
