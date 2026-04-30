import { describe, expect, test } from "bun:test";
import {
  buildActionSurfaceReport,
  buildActionSurfaceReportFromSurface,
  renderActionSurfaceReport,
  validateActionSurfaceReport,
} from "../scripts/action-surface-report";
import { dumpRegistry, type ActionSurfaceEntry } from "../src/action-registry";

function syntheticAction(id: string): ActionSurfaceEntry {
  return {
    id,
    description: "Synthetic action for deterministic report tests.",
    scope: "workflow",
    args: [],
    autonomy: "auto",
    audited: false,
    category: "inspect",
    implementation: { kind: "planned", note: "Synthetic test action." },
    security: { actor: "admin" },
    implemented: false,
  };
}

describe("Action surface report parity guard", () => {
  test("renders deterministically from the registry", () => {
    expect(renderActionSurfaceReport()).toBe(renderActionSurfaceReport());
  });

  test("generates OpenAPI-like and MCP action id surfaces from the same registry ids", () => {
    const report = buildActionSurfaceReport();
    expect(validateActionSurfaceReport(report)).toEqual([]);
    expect(report.openapi.paths["/act"].post.request_schema.properties.action.enum).toEqual(report.parity.registry_action_ids);
    expect(report.openapi.paths["/act/{actionId}"].get.parameters[0].schema.enum).toEqual(report.parity.registry_action_ids);
    expect(report.mcp.tools.map(tool => tool.name)).toEqual([
      "konoha_action_catalog",
      "konoha_action_get",
      "konoha_action_call",
    ]);
    expect(report.parity.mcp_catalog_action_ids).toEqual(report.parity.registry_action_ids);
    expect(report.parity.mcp_call_action_ids).toEqual(report.parity.registry_action_ids);
  });

  test("adding an action changes the report deterministically", () => {
    const dump = dumpRegistry();
    const baseline = buildActionSurfaceReportFromSurface(dump.version, dump.surface);
    const extended = buildActionSurfaceReportFromSurface(dump.version, [
      ...dump.surface,
      syntheticAction("zz.synthetic_report_test"),
    ]);

    expect(extended.counts.actions).toBe(baseline.counts.actions + 1);
    expect(extended.parity.registry_action_ids).toContain("zz.synthetic_report_test");
    expect(JSON.stringify(extended)).not.toBe(JSON.stringify(baseline));
    expect(extended).toEqual(buildActionSurfaceReportFromSurface(dump.version, [
      ...dump.surface,
      syntheticAction("zz.synthetic_report_test"),
    ]));
  });

  test("detects drift between registry, HTTP, and MCP surfaces", () => {
    const report = buildActionSurfaceReport();
    const drifted = structuredClone(report);
    drifted.parity.mcp_catalog_action_ids = drifted.parity.mcp_catalog_action_ids.slice(1);

    expect(validateActionSurfaceReport(drifted)).toContain("MCP catalog action ids drift from registry");
  });
});
