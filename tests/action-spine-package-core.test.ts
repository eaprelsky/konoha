import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  createActionRegistry,
  defaultClassifyAction,
  type ActionDef,
} from "../packages/action-spine/src";

const repoRoot = join(import.meta.dir, "..");

type DemoScope = "task" | "report";

const demoActions: ActionDef<DemoScope>[] = [
  {
    id: "task.create",
    description: "Create a task",
    scope: "task",
    args: [
      { name: "title", type: "string", required: true, description: "Task title" },
      { name: "metadata", type: "object", required: false, description: "Optional metadata" },
    ],
    implementation: { kind: "direct", note: "Injected host executor" },
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "task.list",
    description: "List tasks",
    scope: "task",
    args: [],
    currentEndpoint: "GET /tasks",
    autonomy: "auto",
    audited: false,
  },
  {
    id: "report.tree",
    description: "Read report tree",
    scope: "report",
    args: [],
    autonomy: "auto",
    audited: false,
  },
];

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

describe("@konoha/action-spine generic core package", () => {
  test("creates a host-owned registry without Konoha vocabulary", () => {
    const registry = createActionRegistry<DemoScope>({
      version: 3,
      actions: demoActions,
      getActionSecurity: action => action.id === "task.create"
        ? { actor: "admin" }
        : { actor: "authenticated" },
    });

    expect(registry.version).toBe(3);
    expect(registry.list().map(action => action.id)).toEqual(["task.create", "task.list", "report.tree"]);
    expect(registry.list("task").map(action => action.id)).toEqual(["task.create", "task.list"]);
    expect(registry.get("task.create")?.scope).toBe("task");

    const surface = registry.surface();
    expect(surface.find(action => action.id === "task.create")).toMatchObject({
      category: "act",
      implemented: true,
      security: { actor: "admin" },
    });
    expect(surface.find(action => action.id === "report.tree")).toMatchObject({
      category: "drill",
      security: { actor: "authenticated" },
    });
  });

  test("validates arguments with reusable core rules", () => {
    const registry = createActionRegistry<DemoScope>({ version: 1, actions: demoActions });

    expect(registry.validate("task.create", { title: "Review", metadata: { priority: "high" } })).toEqual({
      valid: true,
      errors: [],
    });
    expect(registry.validate("task.create", {})).toEqual({
      valid: false,
      errors: ["Missing required argument: title"],
    });
    expect(registry.validate("task.create", { title: 42, metadata: [] })).toEqual({
      valid: false,
      errors: [
        'Expected string for "title", got number',
        'Expected object for "metadata"',
      ],
    });
    expect(registry.validate("task.missing", {})).toEqual({
      valid: false,
      errors: ["Unknown action: task.missing"],
    });
  });

  test("rejects duplicate action ids at registry construction", () => {
    expect(() => createActionRegistry({
      version: 1,
      actions: [demoActions[0], demoActions[0]],
    })).toThrow("Duplicate action id: task.create");
  });

  test("package source does not import Konoha host vocabulary or runtime modules", () => {
    const packageFiles = [
      "packages/action-spine/src/core-types.ts",
      "packages/action-spine/src/ports.ts",
      "packages/action-spine/src/registry.ts",
      "packages/action-spine/src/bridges/mcp.ts",
      "packages/action-spine/src/bridges/cli.ts",
      "packages/action-spine/src/bridges/http.ts",
      "packages/action-spine/src/index.ts",
    ];
    const combined = packageFiles.map(read).join("\n");

    for (const forbidden of [
      "action-definitions",
      "action-registry",
      "action-policy",
      "workflow-loader",
      "runtime/",
      "agent-lifecycle",
      "mcp-action-bridge",
      "act-envelope",
      "KonohaActionScope",
      "workflow.deploy",
      "case.start",
    ]) {
      expect(combined.includes(forbidden), `package source contains ${forbidden}`).toBe(false);
    }
  });

  test("default classifier is generic verb-based behavior", () => {
    expect(defaultClassifyAction("task.create")).toBe("act");
    expect(defaultClassifyAction("task.list")).toBe("inspect");
    expect(defaultClassifyAction("report.tree")).toBe("drill");
  });
});
