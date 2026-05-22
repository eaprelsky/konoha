import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ACTION_SPINE_CORE_FILES,
  ACTION_SPINE_FORBIDDEN_CORE_IMPORTS,
  ACTION_SPINE_KONOHA_ADAPTER_FILES,
  ACTION_SPINE_KONOHA_VOCABULARY_FILES,
  ACTION_SPINE_PACKAGE_BRIDGE_FILES,
  ACTION_SPINE_PORTS,
} from "../src/action-spine/boundary";
import { konohaActionExecutorPort } from "../src/action-executor";

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
  test("documents a small generic core, Konoha vocabulary, and explicit adapters", () => {
    expect(ACTION_SPINE_CORE_FILES).toEqual([
      "src/action-spine/core-types.ts",
      "src/action-spine/ports.ts",
      "packages/action-spine/src/core-types.ts",
      "packages/action-spine/src/ports.ts",
      "packages/action-spine/src/registry.ts",
      "packages/action-spine/src/index.ts",
    ]);
    expect(ACTION_SPINE_CORE_FILES).toContain("src/action-spine/ports.ts");
    expect(ACTION_SPINE_CORE_FILES).not.toContain("src/action-definitions.ts");
    expect(ACTION_SPINE_CORE_FILES).not.toContain("src/action-registry.ts");
    expect(ACTION_SPINE_KONOHA_VOCABULARY_FILES).toEqual([
      "src/action-definitions.ts",
      "src/action-registry.ts",
      "src/action-policy.ts",
    ]);
    expect(ACTION_SPINE_KONOHA_ADAPTER_FILES).toContain("src/action-executor.ts");
    expect(ACTION_SPINE_KONOHA_ADAPTER_FILES).toContain("src/mcp-action-bridge.ts");
    expect(ACTION_SPINE_PACKAGE_BRIDGE_FILES).toEqual([
      "packages/action-spine/src/bridges/mcp.ts",
      "packages/action-spine/src/bridges/cli.ts",
      "packages/action-spine/src/bridges/http.ts",
    ]);
    expect(ACTION_SPINE_PORTS.map(port => port.name)).toEqual([
      "ActionExecutorPort",
      "ActionAuditPort",
      "ActionAutonomyPolicyPort",
      "HttpActionRouteAdapter",
      "McpActionBridgeAdapter",
    ]);
  });

  test("defines the core port interfaces before package extraction", () => {
    const coreTypesSource = readRepoFile("src/action-spine/core-types.ts");
    const portsSource = readRepoFile("src/action-spine/ports.ts");
    const packageIndexSource = readRepoFile("packages/action-spine/src/index.ts");
    expect(coreTypesSource).toContain("interface ActionDef<TScope extends string = string>");
    expect(coreTypesSource).not.toContain("workflow.create");
    expect(coreTypesSource).not.toContain("type KonohaActionScope");
    for (const port of ACTION_SPINE_PORTS) {
      expect(port.source_file).toBe("src/action-spine/ports.ts");
      expect(portsSource).toContain(`interface ${port.name}`);
    }
    expect(portsSource).not.toContain("../action-registry");
    expect(portsSource).toContain("interface ActionExecutionRequest");
    expect(portsSource).toContain("interface ActionEnvelopeResult");
    expect(packageIndexSource).toContain("createActionRegistry");
    expect(packageIndexSource).toContain("createMcpActionBridge");
    expect(packageIndexSource).toContain("createCliBridge");
    expect(packageIndexSource).toContain("createHttpActionAdapter");
  });

  test("keeps concrete Konoha action vocabulary out of generic core types", () => {
    const coreSource = ACTION_SPINE_CORE_FILES.map(readRepoFile).join("\n");
    expect(coreSource).not.toContain('"workflow"');
    expect(coreSource).not.toContain("workflow.create");
    expect(coreSource).not.toContain("konoha:config");
    expect(coreSource).not.toContain("KonohaActionScope");

    const registrySource = readRepoFile("src/action-registry.ts");
    const definitionsSource = readRepoFile("src/action-definitions.ts");
    expect(registrySource).toContain("type KonohaActionScope");
    expect(definitionsSource).toContain("workflow.create");
  });

  test("core files do not import Konoha runtime or agent modules directly", () => {
    for (const file of [...ACTION_SPINE_CORE_FILES, ...ACTION_SPINE_PACKAGE_BRIDGE_FILES]) {
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
    expect(konohaActionExecutorPort.execute).toBeFunction();
  });
});
