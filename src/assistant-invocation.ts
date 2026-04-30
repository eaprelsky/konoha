import { randomUUID } from "crypto";
import { generateText, type LlmMessage } from "./llm";
import { redis } from "./redis";
import { listWorkflows } from "./workflow-loader";
import { normalizeAssistantResponse } from "./assistant-response";
import { ServiceError } from "./errors";

const TSUNADE_CHAT_PREFIX = "tsunade:chat:";
const KIBA_CHAT_PREFIX = "kiba:chat:";
const CHAT_MAX_HISTORY = 20;
const KIBA_CHAT_MAX_HISTORY = 16;

export interface AssistantInvocationArgs {
  assistant_id: string;
  message: string;
  conversation_id?: string;
  context?: string | Record<string, unknown>;
  operator_state?: unknown;
  schema?: unknown;
  stream?: boolean;
  execute_actions?: boolean;
  persist_history?: boolean;
  fixture_response?: string;
  include_raw_response?: boolean;
}

export interface AssistantInvocationResult {
  ok: true;
  assistant_id: string;
  conversation_id: string;
  trace_id: string;
  stream: false;
  reply: string;
  normalized_response: Record<string, unknown>;
  actions_taken: unknown[];
  action_results: unknown[];
  pending_confirmations: unknown[];
  raw_response?: string;
}

function stripMarkdownFences(raw: string): string {
  const match = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  return match ? match[1].trim() : raw;
}

function parseReply(rawReply: string): string {
  try {
    const parsed = JSON.parse(stripMarkdownFences(rawReply)) as Record<string, unknown>;
    const reply = parsed.reply ?? parsed.text ?? parsed.message;
    return typeof reply === "string" ? reply : rawReply;
  } catch {
    return rawReply;
  }
}

function contextToText(context: AssistantInvocationArgs["context"]): string {
  if (!context) return "";
  if (typeof context === "string") return context;
  return JSON.stringify(context, null, 2);
}

async function buildWorkflowListContext(): Promise<string> {
  const workflows = await listWorkflows().catch(() => []);
  if (workflows.length === 0) return "";
  const summary = workflows.slice(0, 50).map(workflow => {
    const record = workflow as unknown as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : workflow.id;
    const draft = record.status === "draft" ? " [draft]" : "";
    return `- ${workflow.id}: ${name}${draft}`;
  }).join("\n");
  return `\n\n[Registered workflows (${workflows.length} total)]\n${summary}`;
}

function systemPromptFor(assistantId: string): string {
  if (assistantId === "kiba") {
    return [
      "You are Kiba, the Konoha administrative assistant.",
      "Return concise JSON with a reply field and optional actions array.",
      "Do not execute unsafe operations directly; surface them as Action Spine actions.",
    ].join("\n");
  }
  return [
    "You are Tsunade, the Konoha workflow assistant and product operator.",
    "Help users inspect, create, update, and run eEPC workflows.",
    "Return valid JSON with a reply field.",
    "When proposing operations, use canonical Action Spine semantics and include structured fields such as create_workflow or start_case when appropriate.",
  ].join("\n");
}

function assertAssistantId(value: string): "tsunade" | "kiba" {
  if (value === "tsunade" || value === "kiba") return value;
  throw new ServiceError(400, `Unsupported assistant_id: ${value}`);
}

async function readHistory(key: string, persistHistory: boolean): Promise<LlmMessage[]> {
  if (!persistHistory) return [];
  const rawHistory = await redis.lrange(key, 0, -1).catch(() => [] as string[]);
  return rawHistory
    .map(raw => {
      try {
        const parsed = JSON.parse(raw) as LlmMessage;
        if (parsed.role === "user" || parsed.role === "assistant") return parsed;
      } catch {}
      return null;
    })
    .filter((item): item is LlmMessage => Boolean(item));
}

async function persistTurn(key: string, maxHistory: number, userMessage: string, assistantMessage: string, persistHistory: boolean): Promise<void> {
  if (!persistHistory) return;
  await redis.rpush(key, JSON.stringify({ role: "user", content: userMessage }));
  await redis.rpush(key, JSON.stringify({ role: "assistant", content: assistantMessage }));
  await redis.ltrim(key, -maxHistory * 2, -1);
  await redis.expire(key, 7 * 24 * 3600);
}

export async function invokeAssistant(args: AssistantInvocationArgs): Promise<AssistantInvocationResult> {
  const assistantId = assertAssistantId(args.assistant_id);
  const message = args.message?.trim();
  if (!message) throw new ServiceError(400, "message required");
  if (args.stream === true) {
    throw new ServiceError(400, "assistant.invoke supports deterministic non-streaming mode only");
  }

  const conversationId = args.conversation_id?.trim() || randomUUID();
  const traceId = `assistant-invoke-${randomUUID()}`;
  const persistHistory = args.persist_history !== false;
  const historyPrefix = assistantId === "kiba" ? KIBA_CHAT_PREFIX : TSUNADE_CHAT_PREFIX;
  const historyKey = historyPrefix + conversationId;
  const maxHistory = assistantId === "kiba" ? KIBA_CHAT_MAX_HISTORY : CHAT_MAX_HISTORY;

  const contextText = contextToText(args.context);
  const schemaContext = args.schema && assistantId === "tsunade"
    ? `\n<process_data>\n${JSON.stringify(args.schema, null, 2)}\n</process_data>`
    : "";
  const workflowContext = assistantId === "tsunade" ? await buildWorkflowListContext() : "";
  const userMessage = [
    message,
    contextText ? `\n\n[Context]\n${contextText}` : "",
    schemaContext,
    workflowContext,
  ].join("");

  const rawResponse = args.fixture_response ?? await generateText({
    model: assistantId === "kiba" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6",
    maxTokens: 2048,
    system: systemPromptFor(assistantId),
    messages: [
      ...await readHistory(historyKey, persistHistory),
      { role: "user", content: userMessage },
    ],
  });

  if (assistantId === "tsunade") {
    const normalized = await normalizeAssistantResponse(rawResponse, {
      chat_id: conversationId,
      execute_actions: args.execute_actions !== false,
      agent_id: "tsunade",
      session_id: traceId,
    });
    await persistTurn(historyKey, maxHistory, message, rawResponse, persistHistory);
    return {
      ok: true,
      assistant_id: assistantId,
      conversation_id: conversationId,
      trace_id: traceId,
      stream: false,
      reply: normalized.reply,
      normalized_response: normalized as unknown as Record<string, unknown>,
      actions_taken: normalized.actions_taken,
      action_results: normalized.action_receipts,
      pending_confirmations: normalized.pending_confirmations,
      ...(args.include_raw_response ? { raw_response: rawResponse } : {}),
    };
  }

  const reply = parseReply(rawResponse);
  await persistTurn(historyKey, maxHistory, message, rawResponse, persistHistory);
  return {
    ok: true,
    assistant_id: assistantId,
    conversation_id: conversationId,
    trace_id: traceId,
    stream: false,
    reply,
    normalized_response: { reply, chat_id: conversationId },
    actions_taken: [],
    action_results: [],
    pending_confirmations: [],
    ...(args.include_raw_response ? { raw_response: rawResponse } : {}),
  };
}
