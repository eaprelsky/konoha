import { describe, expect, test } from "bun:test";
import {
  createActionRegistry,
  createCliBridge,
  createHttpActionAdapter,
  createMcpActionBridge,
  type ActionDef,
  type ActionEnvelopeRequest,
  type ActionExecutorPort,
} from "../packages/action-spine/src";

type DemoScope = "task";

const actions: ActionDef<DemoScope>[] = [
  {
    id: "task.create",
    description: "Create a task",
    scope: "task",
    args: [{ name: "title", type: "string", required: true, description: "Task title" }],
    implementation: { kind: "direct", note: "Injected executor" },
    autonomy: "confirm",
    audited: true,
  },
  {
    id: "task.list",
    description: "List tasks",
    scope: "task",
    args: [],
    implementation: { kind: "direct", note: "Injected executor" },
    autonomy: "auto",
    audited: false,
  },
];

function parseMcp(result: any): any {
  return JSON.parse(result.content[0].text);
}

function registry() {
  return createActionRegistry<DemoScope>({ version: 7, actions });
}

describe("@konoha/action-spine injected bridges", () => {
  test("MCP bridge exposes catalog/get and calls only the injected Action port", async () => {
    const calls: ActionEnvelopeRequest[] = [];
    const bridge = createMcpActionBridge({
      registry: registry(),
      call: input => {
        calls.push(input);
        return { ok: true, action: input.action, action_version: 7, data: { id: "created" } };
      },
    });

    const catalog = parseMcp(await bridge.catalog({ scope: "task" }));
    expect(catalog.action_version).toBe(7);
    expect(catalog.actions.map((action: any) => action.id)).toEqual(["task.create", "task.list"]);

    const get = parseMcp(await bridge.get("task.create"));
    expect(get).toMatchObject({ ok: true, action: { id: "task.create", category: "act" } });

    const created = parseMcp(await bridge.call({
      action: "task.create",
      category: "act",
      args: { title: "Review" },
    }));
    expect(created).toMatchObject({ ok: true, action: "task.create", data: { id: "created" } });
    expect(calls).toEqual([{ action: "task.create", category: "act", args: { title: "Review" } }]);
  });

  test("MCP bridge rejects invalid args before invoking the host port", async () => {
    let called = false;
    const bridge = createMcpActionBridge({
      registry: registry(),
      call: () => {
        called = true;
        return { ok: true };
      },
    });

    const result = parseMcp(await bridge.call({ action: "task.create", category: "act", args: {} }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required argument: title");
    expect(called).toBe(false);
  });

  test("CLI bridge dry-runs mutations and executes reads through the injected executor", async () => {
    const executed: ActionEnvelopeRequest[] = [];
    const executor: ActionExecutorPort = {
      async execute(request) {
        executed.push({ ...request, category: "inspect" });
        return { status: 200, data: [{ id: "task-1" }] };
      },
    };
    const cli = createCliBridge({ registry: registry(), executor });

    const dryRun = await cli.run(["task.create", JSON.stringify({ title: "Review" }), "--dry-run"]);
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      ok: true,
      action: "task.create",
      data: { dry_run: true, category: "act", args: { title: "Review" } },
    });
    expect(executed).toEqual([]);

    const listed = await cli.run(["task.list", "{}"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      ok: true,
      action: "task.list",
      data: [{ id: "task-1" }],
    });
    expect(executed).toHaveLength(1);
  });

  test("HTTP adapter enforces validation/autonomy and records audit through ports", async () => {
    const audits: any[] = [];
    const adapter = createHttpActionAdapter({
      registry: registry(),
      executor: {
        async execute(request) {
          return { status: 201, data: { created: request.args.title } };
        },
      },
      autonomy: {
        async resolve(action) {
          return action.id === "task.create" ? "confirm" : "auto";
        },
      },
      audit: {
        async record(entry) {
          audits.push(entry);
          return { audit_id: `audit-${audits.length}` };
        },
      },
    });

    const blocked = await adapter.execute({
      action: "task.create",
      category: "act",
      args: { title: "Needs approval" },
    }, { session_id: "s1", agent_chain: "test" });
    expect(blocked).toMatchObject({
      ok: false,
      action: "task.create",
      status: 409,
      requires_confirm: true,
    });
    expect(audits[0]).toMatchObject({
      action_type: "task.create",
      result: "requires_confirm",
    });

    const invalid = await adapter.execute({ action: "task.create", category: "act", args: {} }, { skip_autonomy: true });
    expect(invalid).toMatchObject({ ok: false, status: 400 });

    const created = await adapter.execute({
      action: "task.create",
      category: "act",
      args: { title: "Approved" },
    }, { skip_autonomy: true, session_id: "s2", agent_chain: "test" });
    expect(created).toMatchObject({
      ok: true,
      action: "task.create",
      status: 201,
      data: { created: "Approved" },
    });
    expect(audits.at(-1)).toMatchObject({
      action_type: "task.create",
      result: "ok",
    });
  });
});
