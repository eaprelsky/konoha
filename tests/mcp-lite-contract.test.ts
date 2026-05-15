import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";

const BUN = "/home/ubuntu/.bun/bin/bun";
const CWD = "/home/ubuntu/konoha";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpResponse {
  id: number;
  result?: { tools: McpTool[] };
  error?: unknown;
}

function mcpToolsList(env: Record<string, string>, timeoutMs = 15000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(BUN, ["run", "src/mcp.ts"], {
      cwd: CWD,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let initialized = false;

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout waiting for tools/list. stderr: ${stderr.slice(0, 500)}`));
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();

      // Parse JSON-RPC messages line by line
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as McpResponse;
          if (!initialized && msg.id === 0 && msg.result) {
            // Got initialize response, send initialized notification + tools/list
            initialized = true;
            proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
            proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
          } else if (msg.id === 1 && msg.result?.tools) {
            clearTimeout(timer);
            const names = msg.result.tools.map((t: McpTool) => t.name);
            proc.kill();
            resolve(names);
          } else if (msg.id === 1 && msg.error) {
            clearTimeout(timer);
            proc.kill();
            reject(new Error(`tools/list error: ${JSON.stringify(msg.error)}`));
          }
        } catch {
          // Incomplete JSON, continue accumulating
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("exit", (code) => {
      if (code !== null && code !== 0 && !initialized) {
        clearTimeout(timer);
        reject(new Error(`Process exited with code ${code}. stderr: ${stderr.slice(0, 500)}`));
      }
    });

    // Send MCP initialize request
    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }) + "\n");
  });
}

function baseTools(toolNames: string[]): string[] {
  // Filter out process-tools and testbench tools to get only base MCP tools
  const processTools = [
    "konoha_workflow_list", "konoha_workflow_get", "konoha_workflow_create",
    "konoha_workflow_update", "konoha_case_list", "konoha_case_start",
    "konoha_case_get", "konoha_workitem_list", "konoha_workitem_complete",
    "konoha_role_list", "konoha_role_assign", "konoha_skill_list",
    "konoha_mining", "konoha_event_emit",
  ];
  const testbenchTools = [
    "konoha_testbench_navigate", "konoha_testbench_action",
    "konoha_testbench_snapshot", "konoha_testbench_resize",
    "konoha_testbench_reset", "konoha_testbench_status",
  ];
  const exclude = new Set([...processTools, ...testbenchTools]);
  return toolNames.filter((n) => !exclude.has(n));
}

describe("MCP lite/full profile contract", () => {
  const liteTools = ["konoha_register", "konoha_send", "konoha_read", "konoha_heartbeat"];
  const fullOnlyTools = [
    "konoha_agents", "konoha_channels", "konoha_history", "konoha_listen",
    "konoha_complete_task", "konoha_action_catalog", "konoha_action_get",
    "konoha_action_call",
  ];

  test("lite profile registers exactly 4 base tools", async () => {
    const tools = await mcpToolsList({
      KONOHA_URL: "http://127.0.0.1:3200",
      KONOHA_TOKEN: "test-token",
      KONOHA_SKILLS: "konoha-lite",
      no_proxy: "127.0.0.1,localhost",
    });

    const base = baseTools(tools);
    expect(base.sort()).toEqual([...liteTools].sort());
  }, 20000);

  test("full profile registers all 12 base tools", async () => {
    const tools = await mcpToolsList({
      KONOHA_URL: "http://127.0.0.1:3200",
      KONOHA_TOKEN: "test-token",
      // No KONOHA_SKILLS → full profile
      no_proxy: "127.0.0.1,localhost",
    });

    const base = baseTools(tools);
    expect(base.sort()).toEqual([...liteTools, ...fullOnlyTools].sort());
  }, 20000);

  test("lite profile excludes full-only tools", async () => {
    const tools = await mcpToolsList({
      KONOHA_URL: "http://127.0.0.1:3200",
      KONOHA_TOKEN: "test-token",
      KONOHA_SKILLS: "konoha-lite",
      no_proxy: "127.0.0.1,localhost",
    });

    const base = baseTools(tools);
    for (const fullTool of fullOnlyTools) {
      expect(base).not.toContain(fullTool);
    }
  }, 20000);
});
