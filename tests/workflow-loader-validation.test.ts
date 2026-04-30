import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { validateWorkflow, type WorkflowDefinition } from "../src/workflow-loader";
import { makeWorkflowDefinition } from "./factories";

describe("workflow-loader validation", () => {
  test("accepts a minimal valid eEPC workflow", () => {
    const def = makeWorkflowDefinition();
    expect(validateWorkflow(def)).toEqual([]);
  });

  test("rejects processes that do not start with an event", () => {
    const def: WorkflowDefinition = makeWorkflowDefinition({
      elements: [
        { id: "fn_1", type: "function", label: "Review request", role: "Operator" },
        { id: "event_end", type: "event", label: "Done" },
      ],
      flow: [["fn_1", "event_end"]],
    });

    const errors = validateWorkflow(def);
    expect(errors.some((error) => error.rule === 1 && error.message.includes("Process must start with an event"))).toBe(true);
  });

  test("rejects direct event to event transitions", () => {
    const def: WorkflowDefinition = makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Order received" },
        { id: "event_end", type: "event", label: "Order closed" },
      ],
      flow: [["event_start", "event_end"]],
    });

    const errors = validateWorkflow(def);
    expect(errors.some((error) => error.rule === 2 && error.message.includes("directly connected to event"))).toBe(true);
  });

  test("rejects non-function elements that carry roles or systems", () => {
    const def: WorkflowDefinition = makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Order received", role: "Operator", system: "telegram" },
        { id: "fn_1", type: "function", label: "Review request", role: "Operator" },
        { id: "event_end", type: "event", label: "Order closed" },
      ],
    });

    const errors = validateWorkflow(def);
    expect(errors.some((error) => error.rule === 3 && error.message.includes("roles must only be attached to functions"))).toBe(true);
    expect(errors.some((error) => error.rule === 3 && error.message.includes("systems must only be attached to functions"))).toBe(true);
  });

  test("rejects functions without a role", () => {
    const def: WorkflowDefinition = makeWorkflowDefinition({
      elements: [
        { id: "event_start", type: "event", label: "Order received" },
        { id: "fn_1", type: "function", label: "Review request" },
        { id: "event_end", type: "event", label: "Order closed" },
      ],
    });

    const errors = validateWorkflow(def);
    expect(errors.some((error) => error.rule === 5 && error.message.includes("has no role assigned"))).toBe(true);
  });
});

describe("workflow-loader e2e: lead-qualification", () => {
  const workflowPath = join(import.meta.dir, "..", "workflows", "sales", "lead-qualification.json");
  let def: WorkflowDefinition;

  test("loads and validates lead-qualification workflow from disk", () => {
    const raw = readFileSync(workflowPath, "utf-8");
    def = JSON.parse(raw);
    expect(def.id).toBe("lead-qualification");
    expect(def.elements.length).toBeGreaterThanOrEqual(5);
    expect(def.flow.length).toBeGreaterThanOrEqual(4);
    const errors = validateWorkflow(def);
    expect(errors).toEqual([]);
  });

  test("has Telegram lead start event e1", () => {
    const e1 = def.elements.find(el => el.id === "e1");
    expect(e1).toBeDefined();
    expect(e1!.type).toBe("event");
    expect(e1!.trigger?.kind).toBe("message");
    expect(e1!.trigger?.source).toBe("telegram");
    expect(e1!.trigger?.filter).toEqual({ chat_title: "coMind Лиды" });
  });

  test("models lead triage followed by human sales owner tasks", () => {
    const stages = def.elements
      .filter(el => el.type === "function")
      .map(el => ({ id: el.id, label: el.label, role: el.role, documents: el.documents }));
    expect(stages).toEqual([
      { id: "f1", label: "Разобрать входящий сигнал", role: "lead_triage_specialist", documents: ["sales.lead.triage"] },
      { id: "f2", label: "Проверить лид и выбрать следующий шаг", role: "sales_owner", documents: ["sales.lead.human-review"] },
      { id: "f_notify_owner", label: "Уведомить владельца продаж о новом лиде", role: "sales_owner", documents: ["sales.lead.owner-notification"] },
      { id: "f3", label: "Подготовить содержательное предложение", role: "sales_owner", documents: ["sales.lead.content-proposal"] },
      { id: "f4", label: "Подготовить запрос оценки", role: "sales_owner", documents: ["sales.lead.estimate-request"] },
      { id: "f5", label: "Собрать КП и следующий follow-up", role: "sales_owner", documents: ["sales.lead.commercial-followup"] },
      { id: "f6", label: "Обработать follow-up напоминание", role: "sales_owner", documents: ["sales.lead.followup-reminder"] },
    ]);
  });

  test("keeps function instructions as workflow document seeds", () => {
    expect(def.documents?.map(doc => doc.doc_id).sort()).toEqual([
      "sales.lead.commercial-followup",
      "sales.lead.content-proposal",
      "sales.lead.estimate-request",
      "sales.lead.followup-reminder",
      "sales.lead.human-review",
      "sales.lead.owner-notification",
      "sales.lead.triage",
    ]);
    expect(def.elements.filter(el => el.type === "function").every(el => !el.intent)).toBe(true);
  });

  test("has one terminal event for the handled follow-up", () => {
    const eventIdsWithOutgoing = new Set(def.flow.map(([from]) => from));
    const terminals = def.elements.filter(el => el.type === "event" && !eventIdsWithOutgoing.has(el.id));
    expect(terminals.map(el => el.id)).toEqual(["e7"]);
  });

  test("represents follow-up reminder as a visible timer event", () => {
    const event = def.elements.find(el => el.id === "e6");
    expect(event?.type).toBe("event");
    expect(event?.trigger).toEqual({
      kind: "delay_after",
      duration: "P1D",
      ref_event: "e5",
    });
  });

  test("flow edges reference valid element IDs", () => {
    const validIds = new Set(def.elements.map(el => el.id));
    for (const [from, to] of def.flow) {
      expect(validIds.has(from)).toBe(true);
      expect(validIds.has(to)).toBe(true);
    }
  });
});

describe("workflow-loader e2e: sdd-harness-factory", () => {
  const workflowPath = join(import.meta.dir, "..", "workflows", "sdd", "harness-factory.json");
  let def: WorkflowDefinition;

  test("loads and validates SDD harness workflow from disk", () => {
    const raw = readFileSync(workflowPath, "utf-8");
    def = JSON.parse(raw);
    expect(def.id).toBe("sdd-harness-factory");
    expect(def.elements.length).toBeGreaterThanOrEqual(10);
    expect(validateWorkflow(def)).toEqual([]);
  });

  test("uses business roles and instruction documents", () => {
    const functions = def.elements.filter(el => el.type === "function");
    expect(functions.map(el => el.role)).toEqual([
      "engineering_lead",
      "developer",
      "developer",
      "test_executor",
      "test_lead",
      "engineering_lead",
      "developer",
    ]);
    expect(functions.every(el => Array.isArray(el.documents) && el.documents.length === 1)).toBe(true);
    expect(def.documents?.map(doc => doc.doc_id).sort()).toEqual([
      "sdd.design-slice",
      "sdd.implementation",
      "sdd.issue-intake",
      "sdd.merge-gate",
      "sdd.review",
      "sdd.rework",
      "sdd.test-plan",
    ]);
  });

  test("models failed tests as an explicit rework loop", () => {
    expect(def.flow).toContainEqual(["g_tests", "f_review", "payload.tests_passed === true"]);
    expect(def.flow).toContainEqual(["g_tests", "f_rework", "payload.tests_passed === false"]);
    expect(def.flow).toContainEqual(["e_rework_ready", "f_test"]);
  });
});

describe("workflow-loader e2e: knowledge-intake", () => {
  const workflowPath = join(import.meta.dir, "..", "workflows", "knowledge", "intake.json");
  let def: WorkflowDefinition;

  test("loads and validates knowledge intake workflow from disk", () => {
    const raw = readFileSync(workflowPath, "utf-8");
    def = JSON.parse(raw);
    expect(def.id).toBe("knowledge-intake");
    expect(validateWorkflow(def)).toEqual([]);
  });

  test("uses business roles and treats KB as an information system", () => {
    const functions = def.elements.filter(el => el.type === "function");
    expect(functions.map(el => el.role)).toEqual([
      "knowledge_intake_lead",
      "knowledge_curator",
      "knowledge_curator",
      "knowledge_reviewer",
      "knowledge_publisher",
    ]);
    expect(functions.map(el => el.role).some(role => String(role).toLowerCase().includes("jiraiya"))).toBe(false);
    expect(functions.flatMap(el => el.systems ?? []).map(system => system.connector)).toEqual([
      "knowledge_base",
      "knowledge_base",
      "knowledge_base",
    ]);
    expect(def.documents?.map(doc => doc.doc_id).sort()).toEqual([
      "knowledge.intake.classification",
      "knowledge.intake.discovery",
      "knowledge.intake.extraction",
      "knowledge.intake.publish",
      "knowledge.intake.review",
    ]);
  });
});

describe("workflow-loader e2e: knowledge source classification", () => {
  const workflowPath = join(import.meta.dir, "..", "workflows", "knowledge", "source-classification.json");
  let def: WorkflowDefinition;

  test("loads and validates classification workflow from disk", () => {
    const raw = readFileSync(workflowPath, "utf-8");
    def = JSON.parse(raw);
    expect(def.id).toBe("knowledge-source-classification");
    expect(validateWorkflow(def)).toEqual([]);
  });

  test("keeps classification rules visible as workflow documents", () => {
    const docs = new Map(def.documents?.map(doc => [doc.doc_id, doc]));
    const policy = docs.get("knowledge.source.classification.policy");
    const output = docs.get("knowledge.source.classification.output");

    expect(policy?.type).toBe("instruction");
    expect(output?.type).toBe("instruction");
    expect(policy?.content).toContain("Meeting transcript");
    expect(policy?.content).toContain("Chat thread");
    expect(policy?.content).toContain("Proposal");
    expect(policy?.content).toContain("ADR");
    expect(policy?.content).toContain("External article");
    expect(output?.content).toContain("intake_decision");
    expect(output?.content).toContain("extraction_scope");
  });

  test("attaches classification documents to functions that need them", () => {
    const classify = def.elements.find(el => el.id === "f_classify_source");
    const review = def.elements.find(el => el.id === "f_review_escalation");

    expect(classify?.documents).toEqual([
      "knowledge.source.classification.policy",
      "knowledge.source.classification.output",
    ]);
    expect(review?.documents).toEqual(["knowledge.source.classification.policy"]);
  });
});

describe("workflow-loader e2e: retention cleanup", () => {
  const workflowPath = join(import.meta.dir, "..", "workflows", "reliability", "retention-cleanup.json");
  let def: WorkflowDefinition;

  test("loads and validates retention cleanup workflow from disk", () => {
    const raw = readFileSync(workflowPath, "utf-8");
    def = JSON.parse(raw);
    expect(def.id).toBe("retention-cleanup");
    expect(validateWorkflow(def)).toEqual([]);
  });

  test("models scheduled report, preview, approval, and guarded apply through Action Spine", () => {
    const start = def.elements.find(el => el.id === "e_retention_audit_due");
    expect(start?.type).toBe("event");
    expect(start?.trigger).toEqual({ kind: "timer", cron: "0 3 * * *" });

    const actionFunctions = def.elements
      .filter(el => el.type === "function")
      .map(el => ({ id: el.id, operation: el.systems?.[0]?.operation }));
    expect(actionFunctions).toContainEqual({ id: "f_generate_retention_report", operation: "retention.report" });
    expect(actionFunctions).toContainEqual({ id: "f_generate_cleanup_preview", operation: "retention.cleanup_preview" });
    expect(actionFunctions).toContainEqual({ id: "f_apply_cleanup", operation: "retention.cleanup_apply" });
  });

  test("requires human approval before destructive cleanup apply", () => {
    const approval = def.elements.find(el => el.id === "f_review_cleanup_approval");
    const apply = def.elements.find(el => el.id === "f_apply_cleanup");

    expect(approval?.type).toBe("function");
    expect(approval?.role).toBe("platform_owner");
    expect(approval?.documents).toEqual(["retention.cleanup.approval"]);
    expect(apply?.documents).toEqual(["retention.cleanup.apply"]);

    expect(def.flow).toContainEqual(["f_review_cleanup_approval", "e_cleanup_review_recorded"]);
    expect(def.flow).toContainEqual(["g_cleanup_approved", "e_cleanup_approved", "payload.approved === true"]);
    expect(def.flow).toContainEqual(["e_cleanup_approved", "f_apply_cleanup"]);
  });

  test("publishes a summary for every terminal branch", () => {
    expect(def.flow).toContainEqual(["e_no_cleanup_needed", "f_publish_retention_summary"]);
    expect(def.flow).toContainEqual(["e_cleanup_rejected", "f_publish_retention_summary"]);
    expect(def.flow).toContainEqual(["e_cleanup_applied", "f_publish_retention_summary"]);
    expect(def.flow).toContainEqual(["f_publish_retention_summary", "e_retention_cycle_complete"]);
  });
});
