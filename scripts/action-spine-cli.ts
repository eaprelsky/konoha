#!/usr/bin/env bun
import { classifyAction } from "../src/action-registry";
import { ACTION_VERSION } from "../src/action-registry";
import { executeActionDirect, assertActionArgs } from "../src/action-executor";
import { validateEnvelope, type ActEnvelope, type ActResult } from "../src/act-envelope";

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedArgs {
  action?: string;
  args: Record<string, unknown>;
  dryRun: boolean;
  executeWrite: boolean;
}

function usage(): string {
  return [
    "Usage: bun run scripts/action-spine-cli.ts <action> <json-args> [--dry-run|--execute-write]",
    "",
    "Examples:",
    "  bun run scripts/action-spine-cli.ts workflow.list '{}'",
    "  bun run scripts/action-spine-cli.ts workflow.create '{\"elements\":[],\"flow\":[]}' --dry-run",
  ].join("\n");
}

function parseJsonArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("json-args must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const dryRun = argv.includes("--dry-run");
  const executeWrite = argv.includes("--execute-write");
  const positional = argv.filter(arg => !arg.startsWith("--"));
  return {
    action: positional[0],
    args: parseJsonArgs(positional[1]),
    dryRun,
    executeWrite,
  };
}

function resultText(result: ActResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export async function runActionSpineCli(argv: string[]): Promise<CliRunResult> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e: any) {
    return { exitCode: 2, stdout: "", stderr: `${e.message}\n${usage()}\n` };
  }

  if (!parsed.action || parsed.action === "--help" || parsed.action === "-h") {
    return { exitCode: parsed.action ? 0 : 2, stdout: `${usage()}\n`, stderr: "" };
  }

  const envelope: ActEnvelope = {
    action: parsed.action,
    category: classifyAction(parsed.action),
    args: parsed.args,
  };
  const errors = validateEnvelope(envelope);
  if (errors.length > 0) {
    const result: ActResult = {
      ok: false,
      action: envelope.action,
      error: `Validation: ${errors.map(error => error.message).join("; ")}`,
      action_version: ACTION_VERSION,
    };
    return { exitCode: 1, stdout: resultText(result), stderr: "" };
  }

  if (envelope.category === "act" && !parsed.executeWrite) {
    if (!parsed.dryRun) {
      const result: ActResult = {
        ok: false,
        action: envelope.action,
        error: "Mutation actions require --dry-run or --execute-write",
        action_version: ACTION_VERSION,
      };
      return { exitCode: 1, stdout: resultText(result), stderr: "" };
    }
    const result: ActResult = {
      ok: true,
      action: envelope.action,
      data: { dry_run: true, category: envelope.category, args: envelope.args },
      status: 200,
      action_version: ACTION_VERSION,
    };
    return { exitCode: 0, stdout: resultText(result), stderr: "" };
  }

  const direct = await executeActionDirect(envelope.action, assertActionArgs(envelope.args), {
    compatibilityDefaults: false,
  });
  if (!direct) {
    const result: ActResult = {
      ok: false,
      action: envelope.action,
      error: "Action is registered but not available through the direct CLI executor",
      action_version: ACTION_VERSION,
    };
    return { exitCode: 1, stdout: resultText(result), stderr: "" };
  }

  const ok = direct.status >= 200 && direct.status < 300;
  const result: ActResult = {
    ok,
    action: envelope.action,
    data: ok ? direct.data : undefined,
    error: ok ? undefined : JSON.stringify(direct.data),
    status: direct.status,
    action_version: ACTION_VERSION,
  };
  return { exitCode: ok ? 0 : 1, stdout: resultText(result), stderr: "" };
}

if (import.meta.main) {
  const result = await runActionSpineCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
