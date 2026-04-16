/**
 * action-handlers.ts — Direct handler registration for act-envelope (#527)
 *
 * Registers server-side function implementations for action IDs.
 * Called once at startup from core/src/server.ts.
 *
 * Every handler registered here replaces the Phase 1 HTTP roundtrip
 * with a direct function call — same validation, autonomy, and audit
 * guarantees, zero network overhead.
 *
 * Parity rule: adding a new handler here is the ONLY way to give an
 * action a server-side implementation. Never call handler functions
 * directly from assistant/event code — route through executeAction().
 */

import { registerHandler } from "./act-envelope";
import { createWorkflow } from "./workflow-loader";
import type { WorkflowDefinition } from "./workflow-loader";
import { assistantCreateIssue } from "./assistant-actions";
import { createLogger } from "./logger";

const log = createLogger("action-handlers");
let handlersRegistered = false;

export function registerAllHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  // ── workflow.create ─────────────────────────────────────────────────────────
  registerHandler("workflow.create", async (args) => {
    const wfDef = {
      id: (args.id as string) || `proc_${Date.now().toString(36)}`,
      version: "1.0",
      name: (args.name as string) || "Новый процесс",
      elements: Array.isArray(args.elements) ? args.elements : [],
      flow: Array.isArray(args.flow) ? args.flow : [],
      draft: args.draft !== false,
      ...(typeof args === "object" ? args : {}),
    } as WorkflowDefinition & { draft?: boolean; status?: string };

    const result = await createWorkflow(wfDef, { draft: wfDef.draft !== false });
    if (result.errors.length > 0) {
      throw new Error(result.errors.join(", "));
    }
    const savedWorkflow = result.workflow as WorkflowDefinition & { status?: string };
    return { id: savedWorkflow.id, name: savedWorkflow.name, status: savedWorkflow.status ?? "draft" };
  });

  // ── issue.create ────────────────────────────────────────────────────────────
  registerHandler("issue.create", async (args) => {
    const result = await assistantCreateIssue({
      title: args.title as string,
      body: args.body as string,
      priority: args.priority as any,
      labels: args.labels as string[] | undefined,
    });
    if (result.requires_confirm) {
      throw new Error("issue.create requires confirmation");
    }
    return { number: result.number, url: result.url };
  });

  log.info("action-handlers: registered direct handlers for canonical action spine");
}
