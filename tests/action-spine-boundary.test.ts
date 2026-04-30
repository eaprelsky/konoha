import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ACTION_SPINE_CORE_FILES,
  ACTION_SPINE_FORBIDDEN_CORE_IMPORTS,
  ACTION_SPINE_KONOHA_ADAPTER_FILES,
  ACTION_SPINE_PORTS,
} from "../src/action-spine/boundary";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const importRe = /\bimport(?:\s+type)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
  const dynamicImportRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(importRe)) specs.push(match[1]);
  for (const match of source.matchAll(dynamicImportRe)) specs.push(match[1]);
  return specs;
}

describe("Action Spine package boundary", () => {
  test("documents a small core and explicit Konoha adapters", () => {
    expect(ACTION_SPINE_CORE_FILES).toContain("src/action-registry.ts");
    expect(ACTION_SPINE_CORE_FILES).toContain("src/action-policy.ts");
    expect(ACTION_SPINE_KONOHA_ADAPTER_FILES).toContain("src/action-executor.ts");
    expect(ACTION_SPINE_PORTS.map(port => port.name)).toEqual([
      "ActionExecutorPort",
      "ActionAuditPort",
      "ActionAutonomyPolicyPort",
      "HttpActionRouteAdapter",
      "McpActionBridgeAdapter",
    ]);
  });

  test("core files do not import Konoha runtime or agent modules directly", () => {
    for (const file of ACTION_SPINE_CORE_FILES) {
      const imports = importSpecifiers(readRepoFile(file));
      for (const spec of imports) {
        for (const forbidden of ACTION_SPINE_FORBIDDEN_CORE_IMPORTS) {
          expect(spec.includes(forbidden), `${file} imports ${spec}`).toBe(false);
        }
      }
    }
  });

  test("Konoha execution remains on the adapter side of the boundary", () => {
    const executorImports = importSpecifiers(readRepoFile("src/action-executor.ts"));
    expect(executorImports.some(spec => spec.includes("workflow-loader"))).toBe(true);
    expect(executorImports.some(spec => spec.includes("agent-lifecycle"))).toBe(true);
    expect(ACTION_SPINE_CORE_FILES).not.toContain("src/action-executor.ts");
  });
});
