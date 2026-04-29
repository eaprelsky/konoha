import { describe, expect, it } from "bun:test";
import { evaluateAssertions, runActionScenario } from "../konoha-testbench/src/action-harness";

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
});
