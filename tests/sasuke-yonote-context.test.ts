import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { getToolProfile, ON_DEMAND_SHARED_MCP_PACKS, ROLE_DEFAULT_MCP_ALLOWLISTS } from "../src/agent";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

describe("Sasuke Yonote read-context policy", () => {
  test("chooses on-demand read context without changing Sasuke defaults", () => {
    const policy = JSON.parse(read("docs/sasuke-yonote-context-policy.json"));
    const sasukeDefault = ROLE_DEFAULT_MCP_ALLOWLISTS.find(entry => entry.role === "telegram-user-connector");

    expect(policy.issue).toBe(775);
    expect(policy.decision).toBe("on-demand-only");
    expect(policy.default_mcp_allowlist).toEqual(["konoha", "telethon-channel", "bitrix24"]);
    expect(policy.task_session_mcp_allowlist).toEqual(["konoha", "telethon-channel", "bitrix24", "yonote-read"]);
    expect(policy.task_session_mcp_allowlist).not.toContain("yonote");
    expect(policy.yonote_access.mode).toBe("read-search-only");
    expect(policy.yonote_access.mcp_server).toBe("yonote-read");
    expect(policy.yonote_access.forbidden_mcp_servers).toEqual(["yonote"]);
    expect(policy.yonote_access.forbidden_operations).toEqual(expect.arrayContaining([
      "yonote_request",
      "documents.create",
      "documents.update",
      "documents.delete",
      "documents.export",
      "collections.create",
      "collections.update",
      "collections.delete",
      "attachments.create",
      "attachments.upload",
      "attachments.delete",
    ]));
    expect(policy.yonote_access.context_limits).toMatchObject({
      max_documents: 3,
      max_chars: 6000,
      request_timeout_ms: 60000,
      idle_timeout_sec: 900,
    });
    expect(policy.fallback.must_not_block).toEqual(expect.arrayContaining([
      "telegram:incoming/sasuke",
      "telegram:reaction_updates/sasuke-reactions",
      "agent-watchdog-sasuke.service",
    ]));
    expect(policy.measurement.sasuke_default_process_delta).toBe(0);
    expect(policy.measurement.sasuke_task_session_process_delta).toBe(2);
    expect(sasukeDefault?.mcp_servers).toEqual(["konoha", "telethon-channel", "bitrix24"]);
    expect(getToolProfile("telegram-userbot-yonote-read")?.mcp_servers).toEqual(["telethon-channel", "bitrix24", "yonote-read"]);
    expect(ON_DEMAND_SHARED_MCP_PACKS.get("yonote-read")).toMatchObject({
      feature: "corporate-memory",
      idle_timeout_sec: 900,
    });
  });

  test("read MCP surface excludes raw, write, destructive, export, and attachment upload tools", () => {
    const source = read("scripts/yonote-read-mcp.py");
    const forbidden = [
      "@mcp.tool(annotations=ToolAnnotations(title=\"Raw Yonote RPC Request\"",
      "async def yonote_request(",
      "documents.create",
      "documents.update",
      "documents.delete",
      "documents.export",
      "collections.create",
      "collections.update",
      "collections.delete",
      "attachments.create",
      "attachments.upload",
      "attachments.delete",
      "destructiveHint=True",
    ];

    expect(source).toContain("FastMCP(\"yonote-read\")");
    expect(source).toContain("async def yonote_read_search(");
    expect(source).toContain("async def yonote_read_document(");
    for (const token of forbidden) {
      expect(source).not.toContain(token);
    }
  });

  test("operator documentation records fallback and measured delta", () => {
    const adr = read("docs/adr-008-sasuke-yonote-read-context.md");
    const inventory = read("docs/mcp-resource-inventory.md");
    const catalog = read("docs/mcp-cost-catalog.md");

    expect(adr).toContain("Sasuke does not get Yonote by default");
    expect(adr).toContain("KONOHA_MCP_SESSION_PACKS=yonote-read");
    expect(adr).toContain("raw Yonote RPC");
    expect(adr).toContain("read/search-only");
    expect(adr).toContain("Sasuke persistent default delta | 0 | 0");
    expect(inventory).toContain("Sasuke Yonote Context Decision After #775");
    expect(inventory).toContain("Stale Kiba Yonote MCP | 2 | 24,156");
    expect(catalog).toContain("persistent default delta is 0");
  });
});
