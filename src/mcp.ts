import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.KONOHA_URL || "http://127.0.0.1:3100";
const API_TOKEN = process.env.KONOHA_TOKEN || "konoha-dev-token";

async function api(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const server = new McpServer({
  name: "konoha",
  version: "0.1.0",
});

server.tool(
  "konoha_register",
  "Register this agent on the Konoha bus",
  {
    id: z.string().describe("Unique agent ID (e.g. 'naruto', 'sasuke')"),
    name: z.string().describe("Human-readable agent name"),
    capabilities: z.array(z.string()).optional().describe("List of capabilities"),
    roles: z.array(z.string()).optional().describe("Roles for role-based routing (e.g. 'monitor', 'coder')"),
  },
  async ({ id, name, capabilities, roles }) => {
    const result = await api("POST", "/agents/register", { id, name, capabilities, roles });
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
  },
  async ({ from, to, text, type, channel, replyTo }) => {
    const result = await api("POST", "/messages", { from, to, text, type, channel, replyTo });
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
    const messages = await api("GET", `/messages/${agentId}?count=${count}`);
    if (!messages.length) {
      return { content: [{ type: "text", text: "No new messages." }] };
    }
    const formatted = messages.map((m: any) =>
      `[${m.timestamp}] ${m.from} → ${m.to}: ${m.text}${m.channel ? ` (ch: ${m.channel})` : ""}`
    ).join("\n");
    return { content: [{ type: "text", text: formatted }] };
  }
);

server.tool(
  "konoha_agents",
  "List agents registered on the Konoha bus",
  {
    onlineOnly: z.boolean().optional().default(false).describe("Show only online agents"),
  },
  async ({ onlineOnly }) => {
    const agents = await api("GET", `/agents?online=${onlineOnly}`);
    if (!agents.length) {
      return { content: [{ type: "text", text: "No agents registered." }] };
    }
    const formatted = agents.map((a: any) =>
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
    const channels = await api("GET", "/channels");
    if (!channels.length) {
      return { content: [{ type: "text", text: "No active channels." }] };
    }
    return { content: [{ type: "text", text: channels.join("\n") }] };
  }
);

server.tool(
  "konoha_heartbeat",
  "Send a heartbeat to keep agent status online",
  {
    agentId: z.string().describe("Your agent ID"),
  },
  async ({ agentId }) => {
    await api("POST", `/agents/${agentId}/heartbeat`);
    return { content: [{ type: "text", text: "Heartbeat sent." }] };
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
    const messages = await api("GET", `/messages/${target}/history?count=${count}`);
    if (!messages.length) {
      return { content: [{ type: "text", text: "No history." }] };
    }
    const formatted = messages.map((m: any) =>
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
    const messages: any[] = [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), duration);

    try {
      const res = await fetch(`${API_URL}/messages/${agentId}/stream`, {
        headers: { "Authorization": `Bearer ${API_TOKEN}` },
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

    const formatted = messages.map((m: any) =>
      `[${m.timestamp}] ${m.from} → ${m.to}: ${m.text}`
    ).join("\n");
    return { content: [{ type: "text", text: `Received ${messages.length} message(s):\n${formatted}` }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
