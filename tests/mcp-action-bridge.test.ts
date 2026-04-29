import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actionCall, actionCatalog, actionGet } from "../src/mcp-action-bridge";
import { unregisterAgent } from "../src/redis";

process.env.KONOHA_PORT = "0";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";

const TEST_ADMIN_TOKEN = process.env.KONOHA_TOKEN || "test-admin-token-preload";
const { app } = await import("../core/src/server");

const RUN = `mcp-action-${Date.now()}`;
const AGENT_ID = `${RUN}-agent`;
let agentToken: string | null = null;

function parseResult(result: { content: { type: "text"; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token ?? TEST_ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return res.json() as Promise<T>;
}

beforeAll(async () => {
  const reg = await app.fetch(new Request("http://localhost/agents/register", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: AGENT_ID, name: "MCP Action Bridge Agent" }),
  }));
  const body = await reg.json();
  agentToken = body.token;
});

afterAll(async () => {
  await unregisterAgent(AGENT_ID, true).catch(() => {});
  delete process.env.KONOHA_PORT;
});

describe("MCP Action Spine bridge", () => {
  test("exposes action catalog and single-action contracts", () => {
    const catalog = parseResult(actionCatalog({ scope: "message" }));
    expect(catalog.action_version).toBe(2);
    expect(catalog.actions.map((action: any) => action.id)).toEqual(["message.send", "message.read"]);
    expect(catalog.actions.every((action: any) => action.security.actor !== undefined)).toBe(true);

    const get = parseResult(actionGet("message.send"));
    expect(get.ok).toBe(true);
    expect(get.action.id).toBe("message.send");
    expect(get.action.args.some((arg: any) => arg.name === "text")).toBe(true);
  });

  test("requires an explicit agent token for generic action calls", async () => {
    const result = parseResult(await actionCall(
      { action: "message.send", args: { from: AGENT_ID, to: AGENT_ID, text: "blocked" } },
      { api, tokenProvider: () => null },
    ));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("requires an explicit agent token");
  });

  test("allows permitted actions and returns canonical /act receipts", async () => {
    let captured: { method: string; path: string; body?: any; token?: string } | null = null;
    const result = parseResult(await actionCall(
      { action: "message.send", args: { from: AGENT_ID, to: AGENT_ID, text: "mcp action bridge test" } },
      {
        api: async (method, path, body, token) => {
          captured = { method, path, body, token };
          return { ok: true, action: (body as any).action, action_version: 2, data: { id: "mcp-message-id" } } as any;
        },
        tokenProvider: () => agentToken,
      },
    ));
    expect(result.ok).toBe(true);
    expect(result.action).toBe("message.send");
    expect(result.action_version).toBe(2);
    expect(result.data.id).toBe("mcp-message-id");
    expect(captured).toEqual({
      method: "POST",
      path: "/act",
      token: agentToken,
      body: {
        action: "message.send",
        category: "act",
        args: { from: AGENT_ID, to: AGENT_ID, text: "mcp action bridge test" },
        meta: undefined,
      },
    });
  });

  test("forbidden actions fail consistently with /act", async () => {
    const result = parseResult(await actionCall(
      {
        action: "workflow.create",
        args: { id: `${RUN}-blocked`, name: "Blocked", elements: [], flow: [], draft: true },
      },
      { api, tokenProvider: () => agentToken },
    ));
    expect(result.ok).toBe(false);
    expect(result.action).toBe("workflow.create");
    expect(result.error).toBe("Forbidden: admin token required");
  });
});
