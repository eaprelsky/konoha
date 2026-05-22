import { describe, expect, test } from "bun:test";
import { listOperationalAlerts } from "../src/operational-alerts";
import { saveCase, type Case } from "../src/runtime/cases";
import { buildRuntimeEffectRecord, enqueueRuntimeEffect } from "../src/runtime-effect-outbox";

const RUN = `operational-alerts-${Date.now()}`;

function runningCase(id: string, createdAt: string): Case {
  return {
    case_id: `${RUN}:case:${id}`,
    process_id: `${RUN}:workflow`,
    process_version: "1.0.0",
    subject: `Operational alert ${id}`,
    status: "running",
    position: "review",
    payload: {},
    history: [],
    created_at: createdAt,
  };
}

describe("operational alerts", () => {
  test("emits stable deduplicated alerts for stuck cases and failed effects", async () => {
    const now = "2026-05-22T02:40:00.000Z";
    const oldCase = runningCase("old", "2026-05-21T00:00:00.000Z");
    const youngCase = runningCase("young", "2026-05-22T02:39:30.000Z");
    await saveCase(oldCase);
    await saveCase(youngCase);

    const failed = buildRuntimeEffectRecord({
      kind: "workitem.dispatch",
      idempotency_key: `${RUN}:failed-effect`,
      payload: { role: "reviewer" },
      links: { case_id: oldCase.case_id, work_item_id: `${RUN}:work:failed` },
      status: "failed",
      attempts: 1,
      error: {
        code: "DISPATCH_FAILED",
        message: "dispatch failed",
        retryable: true,
        failed_at: "2026-05-22T02:39:00.000Z",
      },
    }, "2026-05-22T02:39:00.000Z");
    const deadLetter = buildRuntimeEffectRecord({
      kind: "connector.send_message",
      idempotency_key: `${RUN}:dead-letter-effect`,
      payload: { connector_id: "telegram-main" },
      links: { case_id: oldCase.case_id, work_item_id: `${RUN}:work:dead` },
      status: "dead_letter",
      attempts: 5,
      error: {
        code: "CONNECTOR_REJECTED",
        message: "connector rejected",
        retryable: false,
        failed_at: "2026-05-22T02:39:30.000Z",
      },
    }, "2026-05-22T02:39:30.000Z");
    await enqueueRuntimeEffect(failed);
    await enqueueRuntimeEffect(deadLetter);

    const receipt = await listOperationalAlerts({
      now,
      stuck_case_warning_ms: 60_000,
      stuck_case_critical_ms: 60 * 60 * 1000,
      limit: 200,
    });
    const runAlerts = receipt.alerts.filter(alert => alert.correlation.case_id === oldCase.case_id);

    expect(runAlerts).toHaveLength(3);
    expect(runAlerts.map(alert => alert.dedupe_key).sort()).toEqual([...new Set(runAlerts.map(alert => alert.dedupe_key))].sort());
    expect(runAlerts.every(alert => alert.alert_id.startsWith("opalert_") && alert.idempotency_key === alert.dedupe_key)).toBe(true);
    expect(runAlerts.find(alert => alert.kind === "stuck_case")).toMatchObject({
      severity: "critical",
      correlation: { case_id: oldCase.case_id, workflow_id: oldCase.process_id },
      action: { action_type: "case.get", api_path: `/cases/${encodeURIComponent(oldCase.case_id)}` },
    });
    expect(runAlerts.find(alert => alert.correlation.effect_id === failed.effect_id)).toMatchObject({
      kind: "runtime_effect_failed",
      severity: "warning",
      correlation: { case_id: oldCase.case_id, effect_status: "failed", effect_kind: "workitem.dispatch" },
    });
    expect(runAlerts.find(alert => alert.correlation.effect_id === deadLetter.effect_id)).toMatchObject({
      kind: "runtime_effect_failed",
      severity: "critical",
      action: {
        api_path: `/runtime-effects/${deadLetter.effect_id}`,
      },
    });

    const second = await listOperationalAlerts({
      now,
      stuck_case_warning_ms: 60_000,
      stuck_case_critical_ms: 60 * 60 * 1000,
      limit: 200,
    });
    const secondRunAlerts = second.alerts.filter(alert => alert.correlation.case_id === oldCase.case_id);
    expect(secondRunAlerts.map(alert => alert.alert_id).sort()).toEqual(runAlerts.map(alert => alert.alert_id).sort());
  });
});
