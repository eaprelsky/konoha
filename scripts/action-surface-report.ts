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

export function buildActionSurfaceReport() {
  const dump = dumpRegistry();
  const actions = dump.surface.map(toReportAction);
  return {
    schema_version: 1,
    action_version: dump.version,
    generated_from: "src/action-registry.ts",
    counts: {
      actions: actions.length,
      by_scope: countBy(actions.map(action => action.scope)),
      by_category: countBy(actions.map(action => action.category)),
      by_implementation: countBy(actions.map(action => action.implementation.kind)),
      by_security_actor: countBy(actions.map(action => action.security.actor)),
    },
    actions,
  };
}

function validateReport(report: ReturnType<typeof buildActionSurfaceReport>): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  if (report.counts.actions !== report.actions.length) {
    errors.push(`counts.actions=${report.counts.actions} but actions.length=${report.actions.length}`);
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

function renderReport(): string {
  const report = buildActionSurfaceReport();
  const errors = validateReport(report);
  if (errors.length > 0) {
    throw new Error(`Action surface invariant failure:\n${errors.map(error => `- ${error}`).join("\n")}`);
  }
  return `${JSON.stringify(report)}\n`;
}

function writeReport(path = DEFAULT_OUT): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderReport());
}

function checkReport(path = DEFAULT_OUT): void {
  const expected = renderReport();
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
    process.stdout.write(renderReport());
  }
}
