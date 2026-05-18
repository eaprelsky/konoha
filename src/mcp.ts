import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { silentCatch } from "./logger";
import {
  actionCall,
  actionCallSchema,
  actionCatalog,
  actionCatalogSchema,
  actionGet,
  actionGetSchema,
} from "./mcp-action-bridge";

const API_URL = process.env.KONOHA_URL || "http://127.0.0.1:3100";
const ADMIN_TOKEN = process.env.KONOHA_TOKEN || "konoha-dev-token";

// Per-agent token received after registration; falls back to admin token
let agentToken: string | null = process.env.KONOHA_AGENT_TOKEN || null;

interface KonohaMessage {
  id: string;
  timestamp: string;
  from: string;
  to: string;
  text: string;
  channel?: string;
}

interface KonohaAgent {
  id: string;
  name: string;
  status: string;
  roles?: string[];
  capabilities?: string[];
}

interface RegisterResult {
  token?: string;
  id?: string;
  status?: string;
  error?: string;
}

interface SendResult {
  id?: string;
  error?: string;
}

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token || ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<T>;
}

// Use per-agent token if available, otherwise fall back to admin token.
// If the agent token is stale (401 Unauthorized), invalidate it and retry with admin token.
async function agentApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = agentToken || ADMIN_TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && agentToken) {
    // Agent token is stale (e.g. re-registration replaced it); clear it and retry with admin token
    agentToken = null;
    return api<T>(method, path, body, ADMIN_TOKEN);
  }
  return res.json() as Promise<T>;
}

const server = new McpServer({
  name: "konoha",
  version: "0.1.0",
});

// ── Skill gating ────────────────────────────────────────────────────────────
const enabledSkills = (process.env.KONOHA_SKILLS || "").split(",").map(s => s.trim()).filter(Boolean);
const isLite = enabledSkills.includes("konoha-lite");

// ── Lite tools (always registered) ─────────────────────────────────────────

server.tool(
  "konoha_register",
  "Register this agent on the Konoha bus",
  {
    id: z.string().describe("Unique agent ID (e.g. 'naruto', 'sasuke')"),
    name: z.string().describe("Human-readable agent name"),
    capabilities: z.array(z.string()).optional().describe("List of capabilities"),
    roles: z.array(z.string()).optional().describe("Roles for role-based routing (e.g. 'monitor', 'coder')"),
    model: z.string().optional().describe("Model name the agent runs on (e.g. 'claude-sonnet-4-6')"),
    eventSubscriptions: z.array(z.string()).optional().describe("Event types to subscribe to (e.g. ['lead.qualified', 'order.created'])"),
    village_id: z.string().optional().describe("Village this agent belongs to (e.g. 'comind.konoha'); defaults to 'comind.konoha'"),
  },
  async ({ id, name, capabilities, roles, model, eventSubscriptions, village_id }) => {
    const result = await api<RegisterResult>("POST", "/agents/register", { id, name, capabilities, roles, model, eventSubscriptions, village_id });
    // store per-agent token for subsequent calls
    if (result.token) {
      agentToken = result.token;
    }
    // auto-heartbeat every 5 minutes
    setInterval(() => {
      agentApi("POST", `/agents/${id}/heartbeat`).catch(silentCatch("heartbeat"));
    }, 5 * 60 * 1000);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "konoha_send",
  "Send a message to another agent, a role, a channel, or broadcast to all",
  {
    from: z.string().describe("Sender agent ID"),
    to: z.string().describe("Recipient: agent ID, 'all', or 'role:<role>'"),
    text: z.string().describe("Message text"),
    type: z.enum(["message", "task", "result", "status", "event"]).optional().default("message"),
    channel: z.string().optional().describe("Optional topic channel name"),
    replyTo: z.string().optional().describe("Message ID this is a reply to"),
    idempotency_key: z.string().optional().describe("Optional source-stable key to suppress duplicate deliveries"),
    village_id: z.string().optional().describe("Originating village (e.g. 'comind.konoha'); defaults to 'comind.konoha'"),
  },
  async ({ from, to, text, type, channel, replyTo, idempotency_key, village_id }) => {
    const result = await agentApi<SendResult>("POST", "/messages", { from, to, text, type, channel, replyTo, idempotency_key, village_id });
    if (result.error || !result.id) {
      return { content: [{ type: "text", text: `Error sending message: ${result.error || JSON.stringify(result)}` }] };
    }
    return { content: [{ type: "text", text: `Sent. ID: ${result.id}` }] };
  }
);

server.tool(
  "konoha_read",
  "Read new messages for this agent from the bus",
  {
    agentId: z.string().describe("Your agent ID"),
    count: z.number().optional().default(10).describe("Max messages to read"),
  },
  async ({ agentId, count }) => {
    const messages = await agentApi<KonohaMessage[]>("GET", `/messages/${agentId}?count=${count}`);
    if (!messages.length) {
      return { content: [{ type: "text", text: "No new messages." }] };
    }
    const formatted = messages.map((m) =>
      `[${m.timestamp}] ${m.from} → ${m.to}: ${m.text}${m.channel ? ` (ch: ${m.channel})` : ""}`
    ).join("\n");
    return { content: [{ type: "text", text: formatted }] };
  }
);

server.tool(
  "konoha_heartbeat",
  "Send a heartbeat to keep agent status online",
  {
    agentId: z.string().describe("Your agent ID"),
  },
  async ({ agentId }) => {
    await agentApi("POST", `/agents/${agentId}/heartbeat`);
    return { content: [{ type: "text", text: "Heartbeat sent." }] };
  }
);

// ── Full profile tools ─────────────────────────────────────────────────────

if (!isLite) {

server.tool(
  "konoha_agents",
  "List agents registered on the Konoha bus",
  {
    onlineOnly: z.boolean().optional().default(false).describe("Show only online agents"),
  },
  async ({ onlineOnly }) => {
    const agents = await api<KonohaAgent[]>("GET", `/agents?online=${onlineOnly}`);
    if (!agents.length) {
      return { content: [{ type: "text", text: "No agents registered." }] };
    }
    const formatted = agents.map((a) =>
      `${a.status === "online" ? "🟢" : "⚫"} ${a.id} (${a.name}) — roles: ${a.roles?.join(", ") || "none"}, caps: ${a.capabilities?.join(", ") || "none"}`
    ).join("\n");
    return { content: [{ type: "text", text: formatted }] };
  }
);

server.tool(
  "konoha_channels",
  "List active channels on the bus",
  {},
  async () => {
    const channels = await api<string[]>("GET", "/channels");
    if (!channels.length) {
      return { content: [{ type: "text", text: "No active channels." }] };
    }
    return { content: [{ type: "text", text: channels.join("\n") }] };
  }
);

server.tool(
  "konoha_history",
  "Read message history for an agent or channel",
  {
    target: z.string().describe("Agent ID or channel name"),
    count: z.number().optional().default(20).describe("Number of messages"),
  },
  async ({ target, count }) => {
    const messages = await api<KonohaMessage[]>("GET", `/messages/${target}/history?count=${count}`);
    if (!messages.length) {
      return { content: [{ type: "text", text: "No history." }] };
    }
    const formatted = messages.map((m) =>
      `[${m.timestamp}] ${m.from} → ${m.to}: ${m.text}`
    ).join("\n");
    return { content: [{ type: "text", text: formatted }] };
  }
);

server.tool(
  "konoha_listen",
  "Listen for new messages in real-time via SSE. Blocks for the specified duration and returns all messages received.",
  {
    agentId: z.string().describe("Your agent ID"),
    seconds: z.number().optional().default(10).describe("How many seconds to listen (max 60)"),
  },
  async ({ agentId, seconds }) => {
    const duration = Math.min(seconds, 60) * 1000;
    const messages: KonohaMessage[] = [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), duration);

    try {
      const res = await fetch(`${API_URL}/messages/${agentId}/stream`, {
        headers: { "Authorization": `Bearer ${agentToken || ADMIN_TOKEN}` },
        signal: controller.signal,
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ") && line.length > 6) {
              try {
                const msg = JSON.parse(line.slice(6));
                if (msg.from) messages.push(msg);
              } catch {}
            }
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") throw e;
    } finally {
      clearTimeout(timeout);
    }

    if (!messages.length) {
      return { content: [{ type: "text", text: `Listened for ${seconds}s. No new messages.` }] };
    }

    const formatted = messages.map((m) =>
      `[${m.timestamp}] ${m.from} → ${m.to}: ${m.text}`
    ).join("\n");
    return { content: [{ type: "text", text: `Received ${messages.length} message(s):\n${formatted}` }] };
  }
);

server.tool(
  "konoha_complete_task",
  "Complete a work item (process step) and advance the case. Call this after finishing the task that was dispatched to you.",
  {
    work_item_id: z.string().describe("Work item ID from the dispatch message"),
    output: z.record(z.string(), z.unknown()).optional().describe("Task result data to store as step output"),
  },
  async ({ work_item_id, output }) => {
    const result = await agentApi<unknown>(
      "POST",
      `/workitems/${encodeURIComponent(work_item_id)}/complete`,
      output ? { output } : {},
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

  // ── Action Spine tools ──────────────────────────────────────────────────────
  server.tool(
    "konoha_action_catalog",
    "List canonical Action Spine operations available through /act. Use this before konoha_action_call.",
    actionCatalogSchema,
    async (args) => actionCatalog(args)
  );

  server.tool(
    "konoha_action_get",
    "Get one canonical Action Spine operation contract, including args, security, audit, and implementation metadata.",
    actionGetSchema,
    async ({ action }) => actionGet(action)
  );

  server.tool(
    "konoha_action_call",
    "Invoke a canonical Action Spine operation through /act and return the same action receipt as the API.",
    actionCallSchema,
    async (args) => actionCall(args, {
      api,
      tokenProvider: () => agentToken,
      allowAdminFallback: process.env.KONOHA_MCP_ACTION_ADMIN_FALLBACK === "1",
    })
  );

} // end !isLite full profile block

// ── Process Tools (Skill: process-tools) ─────────────────────────────────────
// These 14 tools are registered only when KONOHA_SKILLS includes "process-tools".
// Assign the skill to an agent via capabilities: ["process-tools"] in its AgentDef.

if (enabledSkills.includes("process-tools")) {

  server.tool(
    "konoha_workflow_list",
    "List workflow definitions (processes)",
    {
      limit: z.number().optional().default(20).describe("Max workflows to return (max 200)"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    async ({ limit, offset }) => {
      const result = await agentApi<unknown>("GET", `/workflows?limit=${limit}&offset=${offset}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_workflow_get",
    "Get a workflow definition by ID",
    {
      id: z.string().describe("Workflow ID"),
    },
    async ({ id }) => {
      const result = await agentApi<unknown>("GET", `/workflows/${encodeURIComponent(id)}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_workflow_create",
    "Create a new workflow definition as draft or validated; this does not deploy runtime triggers",
    {
      id: z.string().describe("Workflow ID (slug, e.g. 'sales/lead-qualification')"),
      name: z.string().describe("Human-readable workflow name"),
      elements: z.array(z.object({
        id: z.string(),
        type: z.string().describe("'event', 'function', 'gateway', 'connector'"),
        label: z.string().optional(),
      }).passthrough()).optional().describe("Workflow elements (nodes and connectors)"),
      draft: z.boolean().optional().default(false).describe("Save as draft instead of validating the definition"),
    },
    async ({ id, name, elements, draft }) => {
      const result = await agentApi<unknown>(
        "POST",
        `/workflows${draft ? "?draft=true" : ""}`,
        { id, name, elements }
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_workflow_update",
    "Update an existing workflow definition as draft or validated; this does not deploy runtime triggers",
    {
      id: z.string().describe("Workflow ID to update"),
      name: z.string().optional().describe("New name"),
      elements: z.array(z.object({
        id: z.string(),
        type: z.string(),
        label: z.string().optional(),
      }).passthrough()).optional().describe("Updated workflow elements"),
      draft: z.boolean().optional().default(false).describe("Save as draft"),
    },
    async ({ id, name, elements, draft }) => {
      const result = await agentApi<unknown>(
        "PUT",
        `/workflows/${encodeURIComponent(id)}${draft ? "?draft=true" : ""}`,
        { name, elements }
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_workflow_deploy",
    "Validate and deploy a workflow, materializing runtime start triggers and marking it executable",
    {
      id: z.string().describe("Workflow ID to deploy"),
    },
    async ({ id }) => {
      const result = await agentApi<unknown>("POST", "/act", {
        action: "workflow.deploy",
        category: "act",
        args: { id },
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_case_list",
    "List process execution cases (runs)",
    {
      process_id: z.string().optional().describe("Filter by workflow/process ID"),
      status: z.string().optional().describe("Filter by status (e.g. 'active', 'completed', 'error')"),
      limit: z.number().optional().default(20).describe("Max cases to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    async ({ process_id, status, limit, offset }) => {
      const params = new URLSearchParams();
      if (process_id) params.set("process_id", process_id);
      if (status) params.set("status", status);
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      const result = await agentApi<unknown>("GET", `/cases?${params}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_case_start",
    "Start a new process execution case",
    {
      process_id: z.string().describe("Workflow/process ID to start"),
      subject: z.string().describe("Case subject (e.g. deal ID, lead name, ticket ID)"),
      context: z.record(z.string(), z.unknown()).optional().describe("Additional context data for the case"),
    },
    async ({ process_id, subject, context }) => {
      const result = await agentApi<unknown>("POST", "/cases", { process_id, subject, ...context });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_case_get",
    "Get a case by ID (includes current state and work items)",
    {
      id: z.string().describe("Case ID"),
    },
    async ({ id }) => {
      const result = await agentApi<unknown>("GET", `/cases/${encodeURIComponent(id)}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_workitem_list",
    "List work items (agent tasks within a process case)",
    {
      assignee: z.string().optional().describe("Filter by assigned agent ID"),
      process_id: z.string().optional().describe("Filter by process/workflow ID"),
      status: z.string().optional().describe("Filter by status (e.g. 'pending', 'done')"),
      deadline_before: z.string().optional().describe("ISO date — return items with deadline before this"),
    },
    async ({ assignee, process_id, status, deadline_before }) => {
      const params = new URLSearchParams();
      if (assignee) params.set("assignee", assignee);
      if (process_id) params.set("process_id", process_id);
      if (status) params.set("status", status);
      if (deadline_before) params.set("deadline_before", deadline_before);
      const result = await agentApi<unknown>("GET", `/workitems?${params}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_workitem_complete",
    "Mark a work item as completed",
    {
      id: z.string().describe("Work item ID"),
      result: z.string().optional().describe("Completion result or note"),
    },
    async ({ id, result: resultNote }) => {
      const body = resultNote ? { result: resultNote } : {};
      const res = await agentApi<unknown>("POST", `/workitems/${encodeURIComponent(id)}/complete`, body);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  );

  server.tool(
    "konoha_role_list",
    "List all roles defined in the system",
    {},
    async () => {
      const result = await agentApi<unknown>("GET", "/roles");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_role_assign",
    "Update (patch) a role — e.g. assign an agent or update role properties",
    {
      id: z.string().describe("Role ID"),
      agent_id: z.string().optional().describe("Agent ID to assign to this role"),
      name: z.string().optional().describe("New role name"),
    },
    async ({ id, agent_id, name }) => {
      const result = await agentApi<unknown>("PATCH", `/roles/${encodeURIComponent(id)}`, { agent_id, name });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_skill_list",
    "List all skills defined in the system",
    {},
    async () => {
      const result = await agentApi<unknown>("GET", "/skills");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_mining",
    "Get process mining data for a workflow — execution stats, bottlenecks, flow analysis",
    {
      id: z.string().describe("Workflow/process ID to analyse"),
    },
    async ({ id }) => {
      const result = await agentApi<unknown>("GET", `/mining/process/${encodeURIComponent(id)}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_event_emit",
    "Emit a business event to the Konoha event bus (may trigger subscribed workflows)",
    {
      type: z.string().describe("Event type (e.g. 'lead.qualified', 'order.created')"),
      source: z.string().describe("Source system or agent ID emitting this event"),
      payload: z.record(z.string(), z.unknown()).describe("Event payload object"),
      village_id: z.string().optional().default("comind.konoha").describe("Village ID"),
    },
    async ({ type, source, payload, village_id }) => {
      const result = await agentApi<unknown>("POST", "/events", { type, source, payload, village_id });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

} // end process-tools skill block

// ── TestBench Tools (Skill: testbench) ───────────────────────────────────────
// Registered only when KONOHA_SKILLS includes "testbench".
// Gives agents access to the konoha-testbench Chromium service (port 3203).

const TESTBENCH_URL = process.env.TESTBENCH_URL || "http://127.0.0.1:3203";

async function tbApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TESTBENCH_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<T>;
}

if (enabledSkills.includes("testbench")) {

  server.tool(
    "konoha_testbench_navigate",
    "Open a URL in the TestBench browser. Returns session_id, final URL, and page title.",
    {
      url: z.string().describe("URL to navigate to (http/https)"),
    },
    async ({ url }) => {
      const result = await tbApi<unknown>("POST", "/testbench/navigate", { url });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_testbench_action",
    "Perform an interaction on the current page: click, type, scroll, hover, press, or clear.",
    {
      type: z.enum(["click", "type", "scroll", "hover", "press", "clear"]).describe("Action type"),
      selector: z.string().optional().describe("CSS selector of the target element"),
      text: z.string().optional().describe("Text to type (for type action)"),
      amount: z.number().optional().describe("Scroll amount in pixels (for scroll action, default 300)"),
      key: z.string().optional().describe("Key to press (for press action, e.g. 'Enter', 'Tab')"),
    },
    async ({ type, selector, text, amount, key }) => {
      const result = await tbApi<unknown>("POST", "/testbench/action", { type, selector, text, amount, key });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_testbench_snapshot",
    "Capture the current page state: screenshot (base64 PNG), accessibility tree, console log, network log, bounding boxes of interactive elements, and overlap analysis.",
    {},
    async () => {
      const result = await tbApi<Record<string, unknown>>("GET", "/testbench/snapshot");
      // Return screenshot separately (it's large) and the rest as JSON
      const { screenshot_base64, ...rest } = result;
      const summary = JSON.stringify(rest, null, 2);
      const parts: { type: "text"; text: string }[] = [
        { type: "text", text: summary },
      ];
      if (screenshot_base64) {
        parts.push({ type: "text", text: `screenshot_base64 length: ${String(screenshot_base64).length} chars (omitted from text output — use /testbench/snapshot directly for image)` });
      }
      return { content: parts };
    }
  );

  server.tool(
    "konoha_testbench_resize",
    "Resize the TestBench browser viewport.",
    {
      width: z.number().int().min(320).max(3840).describe("Viewport width in pixels"),
      height: z.number().int().min(240).max(2160).describe("Viewport height in pixels"),
    },
    async ({ width, height }) => {
      const result = await tbApi<unknown>("POST", "/testbench/resize", { width, height });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_testbench_reset",
    "Reset the TestBench session: navigate to about:blank and clear console/network logs.",
    {},
    async () => {
      const result = await tbApi<unknown>("POST", "/testbench/reset", {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "konoha_testbench_status",
    "Check TestBench pool status: how many sessions are free, busy, or waiting.",
    {},
    async () => {
      const result = await tbApi<unknown>("GET", "/testbench/status");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

} // end testbench skill block

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
