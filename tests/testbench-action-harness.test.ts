import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { evaluateAssertions, runActionScenario } from "../konoha-testbench/src/action-harness";
import {
  listActionScenarios,
  listScenarioRuns,
  replayActionScenario,
  saveActionScenario,
} from "../konoha-testbench/src/scenario-catalog";

const tmpCatalogs: string[] = [];

function makeCatalogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "konoha-testbench-scenarios-"));
  tmpCatalogs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpCatalogs.length > 0) {
    rmSync(tmpCatalogs.pop()!, { recursive: true, force: true });
  }
});

describe("testbench action spine harness", () => {
  it("runs workflow create/list/delete through /act envelopes", async () => {
    const calls: { url: string; body: any; authorization?: string }[] = [];
    const receipts = [
      { ok: true, action: "workflow.create", status: 201, data: { id: "tb-smoke-workflow" }, action_version: 2 },
      { ok: true, action: "workflow.list", status: 200, data: [{ id: "tb-smoke-workflow" }], action_version: 2 },
      { ok: true, action: "workflow.delete", status: 200, data: { id: "tb-smoke-workflow", archived: true }, action_version: 2 },
    ];

    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
        authorization: init?.headers && (init.headers as Record<string, string>).Authorization,
      });
      return Response.json(receipts[calls.length - 1], { status: receipts[calls.length - 1].status });
    }) as unknown as typeof fetch;

    const result = await runActionScenario({
      base_url: "http://konoha.test/",
      token: "test-token",
      fetch_impl: fetchImpl,
      scenario: {
        name: "workflow action smoke",
        steps: [
          {
            name: "create workflow",
            envelope: {
              action: "workflow.create",
              category: "act",
              args: {
                id: "tb-smoke-workflow",
                name: "TestBench smoke workflow",
                elements: [{ id: "start", type: "event", label: "Start" }],
                flow: [],
                draft: true,
              },
            },
            assertions: [
              { path: "ok", equals: true },
              { path: "data.id", equals: "tb-smoke-workflow" },
            ],
          },
          {
            name: "list workflows",
            envelope: { action: "workflow.list", category: "inspect", args: {} },
            assertions: [
              { path: "ok", equals: true },
              { path: "data", exists: true },
            ],
          },
          {
            name: "delete workflow",
            envelope: { action: "workflow.delete", category: "act", args: { id: "tb-smoke-workflow" } },
            assertions: [
              { path: "ok", equals: true },
              { path: "data.archived", equals: true },
            ],
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.total).toBe(3);
    expect(result.passed).toBe(3);
    expect(calls.map(call => call.url)).toEqual([
      "http://konoha.test/act",
      "http://konoha.test/act",
      "http://konoha.test/act",
    ]);
    expect(calls.map(call => call.body.action)).toEqual([
      "workflow.create",
      "workflow.list",
      "workflow.delete",
    ]);
    expect(calls.every(call => call.authorization === "Bearer test-token")).toBe(true);
  });

  it("reports failed receipt assertions without running later steps by default", async () => {
    const fetchImpl = (async () => (
      Response.json({ ok: false, action: "workflow.create", status: 500 })
    )) as unknown as typeof fetch;
    const result = await runActionScenario({
      base_url: "http://konoha.test",
      fetch_impl: fetchImpl,
      scenario: {
        name: "stop on assertion failure",
        steps: [
          {
            envelope: { action: "workflow.create", category: "act", args: { elements: [], flow: [] } },
            assertions: [{ path: "ok", equals: true }],
          },
          {
            envelope: { action: "workflow.list", category: "inspect", args: {} },
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.total).toBe(1);
    expect(result.steps[0].assertions.some(assertion => assertion.path === "ok" && !assertion.ok)).toBe(true);
  });

  it("evaluates receipt field assertions", () => {
    const assertions = evaluateAssertions(
      { ok: true, action: "workflow.list", data: { count: 2 } },
      [
        { path: "ok", equals: true },
        { path: "data.count", equals: 2 },
        { path: "data.items", exists: false },
      ],
    );

    expect(assertions.every(assertion => assertion.ok)).toBe(true);
  });

  it("saves and lists action scenarios in a file-backed catalog", () => {
    const catalogDir = makeCatalogDir();
    const scenario = saveActionScenario({
      id: "workflow-smoke",
      title: "Workflow smoke",
      tags: ["workflow", "smoke"],
      steps: [
        {
          envelope: { action: "workflow.list", category: "inspect", args: {} },
          assertions: [{ path: "ok", equals: true }],
        },
      ],
    }, catalogDir);

    expect(scenario.id).toBe("workflow-smoke");
    expect(scenario.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listActionScenarios(catalogDir).map(item => item.id)).toEqual(["workflow-smoke"]);
  });

  it("replays a saved scenario through /act and stores receipts", async () => {
    const catalogDir = makeCatalogDir();
    saveActionScenario({
      id: "workflow-replay",
      title: "Workflow replay",
      steps: [
        {
          envelope: { action: "workflow.list", category: "inspect", args: {} },
          assertions: [{ path: "ok", equals: true }],
        },
      ],
    }, catalogDir);

    const calls: { url: string; body: any }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({ ok: true, action: "workflow.list", status: 200, data: [] });
    }) as unknown as typeof fetch;

    const run = await replayActionScenario({
      id: "workflow-replay",
      base_url: "http://konoha.test",
      token: "test-token",
      fetch_impl: fetchImpl,
      catalog_dir: catalogDir,
    });

    expect(run.scenario_id).toBe("workflow-replay");
    expect(run.result.ok).toBe(true);
    expect(run.result.steps[0].receipt?.action).toBe("workflow.list");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://konoha.test/act");
    expect(calls[0].body.action).toBe("workflow.list");
    expect(listScenarioRuns(catalogDir)).toHaveLength(1);
  });

  it("stores failed replay results and stops by default", async () => {
    const catalogDir = makeCatalogDir();
    saveActionScenario({
      id: "workflow-failure",
      title: "Workflow failure",
      steps: [
        {
          envelope: { action: "workflow.create", category: "act", args: { id: "wf" } },
          assertions: [{ path: "ok", equals: true }],
        },
        {
          envelope: { action: "workflow.list", category: "inspect", args: {} },
        },
      ],
    }, catalogDir);

    const calls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return Response.json({ ok: false, action: "workflow.create", status: 422 }, { status: 422 });
    }) as unknown as typeof fetch;

    const run = await replayActionScenario({
      id: "workflow-failure",
      base_url: "http://konoha.test",
      fetch_impl: fetchImpl,
      catalog_dir: catalogDir,
    });

    expect(run.result.ok).toBe(false);
    expect(run.result.status).toBe("failed");
    expect(run.result.total).toBe(1);
    expect(calls).toEqual(["http://konoha.test/act"]);
    expect(listScenarioRuns(catalogDir)[0].result.status).toBe("failed");
  });
});
