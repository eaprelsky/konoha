import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildResetPlan,
  loadStagingContract,
  parseEnvFile,
  stagingDefaults,
  validateStagingEnv,
} from "../scripts/staging-environment";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

describe("staging environment contract", () => {
  test("defines isolated staging-core runtime boundaries", () => {
    const contract = loadStagingContract();

    expect(contract.environment).toBe("staging");
    expect(contract.service_profile).toBe("staging-core");
    expect(contract.ports.konoha_port).toBe(3210);
    expect(contract.ports.forbidden_ports).toEqual(expect.arrayContaining([3200, 3201, 3202]));
    expect(contract.storage.redis.db).toBeGreaterThan(0);
    expect(contract.storage.redis.db).not.toBe(contract.storage.redis.forbidden_db);
    expect(contract.storage.postgres.database_name).toContain("staging");
    expect(contract.storage.postgres.schema).toBe("konoha_staging");
    expect(contract.storage.postgres.forbidden_schema).toBe("public");
    expect(contract.connectors.enabled_by_default).toEqual([]);
    expect(contract.connectors.disabled_by_default).toEqual(expect.arrayContaining(["telegram", "bitrix24", "yonote"]));
    expect(contract.agents.village_id).toBe("staging.konoha");
    expect(contract.agents.workdir_root).toContain("staging");
    expect(contract.agents.allowed_agent_ids.every(id => id.startsWith(contract.agents.id_prefix))).toBe(true);
    expect(contract.agents.forbidden_production_ids).toEqual(expect.arrayContaining(["naruto", "sasuke", "kakashi"]));
  });

  test("env template validates and keeps staging away from production paths", () => {
    const contract = loadStagingContract();
    const env = parseEnvFile(join(repoRoot, contract.env_template));
    const validation = validateStagingEnv(env, contract);

    expect(validation.ok).toBe(true);
    expect(validation.env.KONOHA_SERVICE_PROFILE).toBe("staging-core");
    expect(validation.env.KONOHA_ENV).toBe("staging");
    expect(validation.env.KONOHA_URL).toBe(validation.env.KONOHA_STAGING_URL);
    expect(validation.env.KONOHA_PORT).toBe("3210");
    expect(validation.env.REDIS_DB).toBe("2");
    expect(validation.env.DATABASE_URL).toBe(validation.env.STAGING_DATABASE_URL);
    expect(validation.env.DATABASE_URL).toContain("konoha_staging");
    expect(validation.env.DATABASE_URL).toContain("search_path%3Dkonoha_staging%2Cpublic");
    expect(validation.env.KONOHA_AGENT_WORKDIR_ROOT).toContain("agent-workdirs-staging");
  });

  test("guardrails reject production-looking staging configuration", () => {
    const contract = loadStagingContract();
    const base = stagingDefaults(contract);
    const validation = validateStagingEnv({
      ...base,
      KONOHA_PORT: "3200",
      KONOHA_URL: "https://agent.eaprelsky.ru",
      KONOHA_STAGING_URL: "https://agent.eaprelsky.ru",
      REDIS_DB: "0",
      DATABASE_URL: "postgres://127.0.0.1:5432/konoha?options=-c%20search_path%3Dpublic",
      STAGING_DATABASE_URL: "postgres://127.0.0.1:5432/konoha?options=-c%20search_path%3Dpublic",
      KONOHA_AGENT_WORKDIR_ROOT: "/opt/shared/agent-workdirs",
    }, contract);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("reserved port 3200");
    expect(validation.errors.join("\n")).toContain("production DB 0");
    expect(validation.errors.join("\n")).toContain("production agent.eaprelsky.ru");
    expect(validation.errors.join("\n")).toContain("staging search_path");
    expect(validation.errors.join("\n")).toContain("staging-specific");
  });

  test("external connectors require explicit staging waiver", () => {
    const contract = loadStagingContract();
    const env = { ...stagingDefaults(contract), KONOHA_ENABLED_CONNECTORS: "telegram" };

    expect(validateStagingEnv(env, contract).errors.join("\n")).toContain("KONOHA_STAGING_ENABLE_EXTERNAL_CONNECTORS");
    expect(validateStagingEnv({ ...env, KONOHA_STAGING_ENABLE_EXTERNAL_CONNECTORS: "waiver-753" }, contract).ok).toBe(true);
  });

  test("reset plan is bounded and never uses broad destructive commands", () => {
    const plan = buildResetPlan(loadStagingContract());

    expect(plan.redis).toContain("konoha:agent:*");
    expect(plan.postgres).toContain("cases");
    expect(plan.postgres).toContain("work_items");
    expect(plan.forbidden).toEqual(expect.arrayContaining(["FLUSHDB", "FLUSHALL", "DROP DATABASE", "REDIS_DB=0"]));
    expect(JSON.stringify(plan)).not.toContain("public.");
  });

  test("docs and preflight expose staging smoke and rollback path", () => {
    const docs = read("docs/staging-environment.md");
    const configuration = read("docs/configuration.md");
    const testing = read("docs/testing.md");
    const ports = read("docs/ports.md");
    const preflightPortable = read("scripts/preflight-portable.sh");
    const preflight = read("scripts/preflight.sh");

    expect(docs).toContain("scripts/staging-smoke.sh --dry-run");
    expect(docs).toContain("scripts/staging-smoke.sh --live");
    expect(docs).toContain("bun run scripts/staging-environment.ts reset --apply");
    expect(docs).toContain("Rollback does not stop or restart production");
    expect(configuration).toContain("Staging Environment");
    expect(testing).toContain("scripts/staging-smoke.sh --dry-run");
    expect(ports).toContain("3210");
    expect(preflightPortable).toContain("tests/staging-environment.test.ts");
    expect(preflight).toContain("scripts/staging-smoke.sh --dry-run");
  });
});
