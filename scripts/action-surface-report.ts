#!/usr/bin/env bun
/**
 * action-surface-report.ts — deterministic Action Spine surface report (#600)
 *
 * The report is intentionally machine-readable and stable: docs, MCP tooling,
 * testbench harnesses, and GUI affordance generation can consume it without
 * importing server internals.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { dumpRegistry, type ActionSurfaceEntry } from "../src/action-registry";

const DEFAULT_OUT = "docs/action-surface.json";
const VALID_CATEGORIES = new Set(["act", "inspect", "drill"]);
const VALID_IMPLEMENTATIONS = new Set(["direct", "endpoint", "registered-handler", "planned"]);
const VALID_ACTORS = new Set(["admin", "authenticated", "agent_self"]);

function countBy<T extends string>(values: T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of [...values].sort()) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function toReportAction(action: ActionSurfaceEntry) {
  return {
    id: action.id,
    description: action.description,
    scope: action.scope,
    category: action.category,
    implemented: action.implemented,
    implementation: action.implementation,
    security: action.security,
    audited: action.audited,
    current_endpoint: action.currentEndpoint ?? null,
    args: action.args,
    result_schema: action.result_schema ?? null,
  };
}

function actionIds(actions: ReturnType<typeof toReportAction>[]): string[] {
  return actions.map(action => action.id).sort();
}

function buildOpenApiSurface(actions: ReturnType<typeof toReportAction>[]) {
  const ids = actionIds(actions);
  return {
    openapi: "3.1.0",
    info: {
      title: "Konoha Action Spine",
      version: String(dumpRegistry().version),
    },
    paths: {
      "/act": {
        post: {
          operation_id: "postAct",
          action_ids: ids,
          request_schema: {
            type: "object",
            required: ["action", "category", "args"],
            properties: {
              action: { type: "string", enum: ids },
              category: { type: "string", enum: ["act", "inspect", "drill"] },
              args: { type: "object" },
              meta: { type: "object" },
            },
          },
        },
        get: {
          operation_id: "listActions",
          action_ids: ids,
        },
      },
      "/act/{actionId}": {
        get: {
          operation_id: "getAction",
          action_ids: ids,
          parameters: [{ name: "actionId", in: "path", required: true, schema: { type: "string", enum: ids } }],
        },
      },
    },
  };
}

function buildMcpSurface(actions: ReturnType<typeof toReportAction>[]) {
  const ids = actionIds(actions);
  return {
    tools: [
      {
        name: "konoha_action_catalog",
        action_ids: ids,
        filters: ["scope", "category", "include_planned"],
      },
      {
        name: "konoha_action_get",
        action_ids: ids,
        required_args: ["action"],
      },
      {
        name: "konoha_action_call",
        action_ids: ids,
        required_args: ["action"],
        envelope_fields: ["action", "category", "args", "meta"],
      },
    ],
  };
}

export function buildActionSurfaceReportFromSurface(
  version: number,
  surface: ActionSurfaceEntry[],
  generatedFrom = "src/action-registry.ts",
) {
  const actions = surface.map(toReportAction);
  const ids = actionIds(actions);
  const openapi = buildOpenApiSurface(actions);
  openapi.info.version = String(version);
  const mcp = buildMcpSurface(actions);
  return {
    schema_version: 1,
    action_version: version,
    generated_from: generatedFrom,
    counts: {
      actions: actions.length,
      by_scope: countBy(actions.map(action => action.scope)),
      by_category: countBy(actions.map(action => action.category)),
      by_implementation: countBy(actions.map(action => action.implementation.kind)),
      by_security_actor: countBy(actions.map(action => action.security.actor)),
    },
    parity: {
      registry_action_ids: ids,
      http_act_action_ids: openapi.paths["/act"].post.action_ids,
      http_get_action_ids: openapi.paths["/act/{actionId}"].get.action_ids,
      mcp_catalog_action_ids: mcp.tools.find(tool => tool.name === "konoha_action_catalog")?.action_ids ?? [],
      mcp_call_action_ids: mcp.tools.find(tool => tool.name === "konoha_action_call")?.action_ids ?? [],
    },
    openapi,
    mcp,
    actions,
  };
}

export function buildActionSurfaceReport() {
  const dump = dumpRegistry();
  return buildActionSurfaceReportFromSurface(dump.version, dump.surface);
}

export function validateActionSurfaceReport(report: ReturnType<typeof buildActionSurfaceReport>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const registryIds = report.parity.registry_action_ids;

  if (report.counts.actions !== report.actions.length) {
    errors.push(`counts.actions=${report.counts.actions} but actions.length=${report.actions.length}`);
  }
  if (JSON.stringify(actionIds(report.actions)) !== JSON.stringify(registryIds)) {
    errors.push("parity.registry_action_ids does not match actions");
  }
  if (JSON.stringify(report.parity.http_act_action_ids) !== JSON.stringify(registryIds)) {
    errors.push("HTTP /act action ids drift from registry");
  }
  if (JSON.stringify(report.parity.http_get_action_ids) !== JSON.stringify(registryIds)) {
    errors.push("HTTP /act/{actionId} action ids drift from registry");
  }
  if (JSON.stringify(report.parity.mcp_catalog_action_ids) !== JSON.stringify(registryIds)) {
    errors.push("MCP catalog action ids drift from registry");
  }
  if (JSON.stringify(report.parity.mcp_call_action_ids) !== JSON.stringify(registryIds)) {
    errors.push("MCP call action ids drift from registry");
  }

  for (const action of report.actions) {
    if (seen.has(action.id)) errors.push(`${action.id}: duplicate action id`);
    seen.add(action.id);

    if (!VALID_CATEGORIES.has(action.category)) errors.push(`${action.id}: invalid category ${action.category}`);
    if (!VALID_IMPLEMENTATIONS.has(action.implementation.kind)) {
      errors.push(`${action.id}: invalid implementation ${action.implementation.kind}`);
    }
    if (!VALID_ACTORS.has(action.security.actor)) errors.push(`${action.id}: invalid security actor ${action.security.actor}`);
    if (action.implemented && action.implementation.kind === "planned") {
      errors.push(`${action.id}: implemented=true but implementation is planned`);
    }
    if (!action.implemented && action.implementation.kind !== "planned") {
      errors.push(`${action.id}: implemented=false but implementation is ${action.implementation.kind}`);
    }
    if (action.category === "act" && action.implemented && !action.audited) {
      errors.push(`${action.id}: implemented mutation must be audited`);
    }
  }

  return errors;
}

export function renderActionSurfaceReport(): string {
  const report = buildActionSurfaceReport();
  const errors = validateActionSurfaceReport(report);
  if (errors.length > 0) {
    throw new Error(`Action surface invariant failure:\n${errors.map(error => `- ${error}`).join("\n")}`);
  }
  return `${JSON.stringify(report)}\n`;
}

function writeReport(path = DEFAULT_OUT): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderActionSurfaceReport());
}

function checkReport(path = DEFAULT_OUT): void {
  const expected = renderActionSurfaceReport();
  const actual = readFileSync(path, "utf8");
  if (actual !== expected) {
    throw new Error(`${path} is out of date. Run: bun run scripts/action-surface-report.ts --write`);
  }
}

if (import.meta.main) {
  const [, , command, pathArg] = process.argv;
  if (command === "--write") {
    writeReport(pathArg ?? DEFAULT_OUT);
  } else if (command === "--check") {
    checkReport(pathArg ?? DEFAULT_OUT);
    console.log(`action surface report OK (${DEFAULT_OUT})`);
  } else {
    process.stdout.write(renderActionSurfaceReport());
  }
}
