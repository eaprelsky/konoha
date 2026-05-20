import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import {
  DESTRUCTIVE_INTEGRATION_ENV,
  TEST_STORAGE_ENV,
} from "../src/storage/test-isolation";
import { getTestRedisDb } from "./redis-test-utils";

const TESTS_DIR = new URL(".", import.meta.url).pathname;
const REDIS_HELPER = "redis-test-utils.ts";

function listTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
    return [fullPath];
  });
}

describe("Bun Redis test isolation contract", () => {
  test("all test Redis clients go through the audited helper", () => {
    const offenders = listTypeScriptFiles(TESTS_DIR)
      .filter((file) => relative(TESTS_DIR, file) !== REDIS_HELPER)
      .flatMap((file) => {
        const source = readFileSync(file, "utf-8");
        const problems = [];
        if (/from\s+["']ioredis["']/.test(source)) problems.push("imports ioredis directly");
        if (/\bnew\s+Redis\s*\(/.test(source)) problems.push("constructs Redis directly");
        return problems.map((problem) => `${relative(TESTS_DIR, file)}: ${problem}`);
      });

    expect(offenders).toEqual([]);
  });

  test("test Redis DB defaults reject production DB 0", () => {
    expect(() => getTestRedisDb({ [TEST_STORAGE_ENV]: "1", REDIS_DB: "0" })).toThrow(
      "REDIS_DB must be a non-zero isolated DB",
    );
  });

  test("destructive integration override is explicit and auditable", () => {
    expect(getTestRedisDb({ [DESTRUCTIVE_INTEGRATION_ENV]: "1", REDIS_DB: "0" })).toBe(0);
  });
});
