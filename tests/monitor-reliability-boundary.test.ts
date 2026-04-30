import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { validateWorkflow, type WorkflowDefinition } from "../src/workflow-loader";

const root = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

describe("monitor reliability boundary", () => {
  test("documents infra monitor vs workflow-visible reliability responsibilities", () => {
    const doc = read("docs/monitor-reliability-boundary.md");

    expect(doc).toContain("Infra Monitor Runtime");
    expect(doc).toContain("Workflow-Visible Reliability");
    expect(doc).toContain("akamaru.service");
    expect(doc).toContain("scripts/healthcheck-system.py");
    expect(doc).toContain("reliability_operator");
    expect(doc).toContain("incident_owner");
    expect(doc).toContain("Do not rename");
  });

  test("lists actionable follow-up slices", () => {
    const doc = read("docs/monitor-reliability-boundary.md");
    const followUps = doc.match(/^\d+\. /gm) ?? [];
    expect(followUps.length).toBeGreaterThanOrEqual(5);
    expect(doc).toContain("reliability.signal");
    expect(doc).toContain("paused-service");
  });

  test("healthcheck and runbook point at the boundary", () => {
    expect(read("scripts/healthcheck-system.py")).toContain("docs/monitor-reliability-boundary.md");
    expect(read("docs/agent-operations-runbook.md")).toContain("docs/monitor-reliability-boundary.md");
  });

  test("defines a workflow-visible reliability incident triage scenario", () => {
    const def = JSON.parse(read("workflows/reliability/incident-triage.json")) as WorkflowDefinition;
    expect(def.id).toBe("reliability-incident-triage");
    expect(validateWorkflow(def)).toEqual([]);
    expect(def.triggers).toEqual([{ event_type: "reliability.signal", start_node: "e_signal_received" }]);

    const functions = def.elements.filter(el => el.type === "function");
    const roles = functions.map(el => el.role);
    expect(roles).toEqual([
      "reliability_operator",
      "incident_owner",
      "incident_owner",
      "connector_owner",
      "incident_owner",
      "connector_owner",
      "reliability_operator",
    ]);
    expect(roles).not.toContain("kiba");
    expect(roles).not.toContain("akamaru");
    expect(def.documents?.map(doc => doc.doc_id).sort()).toEqual([
      "reliability.diagnosis",
      "reliability.operator-approval",
      "reliability.post-incident",
      "reliability.recovery-plan",
      "reliability.signal.triage",
      "reliability.suppression-review",
    ]);
  });
});
