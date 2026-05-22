#!/usr/bin/env bun
import { getRuntimeEffect, listRuntimeEffectsByStatus, recoverRuntimeEffect } from "../src/runtime-effect-outbox";
import type { RuntimeEffectRecoveryOperation, RuntimeEffectStatus } from "../src/runtime-effect-outbox";

const STATUSES = new Set<RuntimeEffectStatus>(["pending", "in_flight", "succeeded", "failed", "retry", "dead_letter", "cancelled"]);

function usage(code = 2): never {
  console.error([
    "Usage:",
    "  bun run scripts/runtime-effect-recovery.ts list [--status pending,retry,failed,dead_letter] [--limit 50]",
    "  bun run scripts/runtime-effect-recovery.ts show <effect_id>",
    "  bun run scripts/runtime-effect-recovery.ts retry <effect_id> --reason <text> [--actor <id>]",
    "  bun run scripts/runtime-effect-recovery.ts cancel <effect_id> --reason <text> [--actor <id>]",
    "  bun run scripts/runtime-effect-recovery.ts dead-letter <effect_id> --reason <text> [--actor <id>]",
  ].join("\n"));
  process.exit(code);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function parseStatuses(raw: string | undefined): RuntimeEffectStatus[] {
  const values = (raw ?? "pending,retry,failed,dead_letter").split(",").map(value => value.trim()).filter(Boolean);
  const statuses = values.filter((value): value is RuntimeEffectStatus => STATUSES.has(value as RuntimeEffectStatus));
  return statuses.length ? statuses : ["pending", "retry", "failed", "dead_letter"];
}

function actor(args: string[]): string {
  return option(args, "--actor") ?? process.env.KONOHA_RECOVERY_ACTOR ?? process.env.USER ?? "operator";
}

function reason(args: string[]): string {
  return option(args, "--reason") ?? "";
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const [command, effectId, ...rest] = process.argv.slice(2);
  if (command === "--help" || command === "-h") usage(0);
  if (!command) usage();

  if (command === "list") {
    const args = [effectId, ...rest].filter(Boolean);
    const statuses = parseStatuses(option(args, "--status"));
    const limit = Math.max(1, Math.min(200, Number(option(args, "--limit") ?? 50)));
    const listed = await Promise.all(statuses.map(status => listRuntimeEffectsByStatus(status, { limit })));
    print({ ok: true, statuses, limit, effects: listed.flat().sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, limit) });
    return;
  }

  if (command === "show") {
    if (!effectId) usage();
    const effect = await getRuntimeEffect(effectId);
    if (!effect) {
      print({ ok: false, error: "RUNTIME_EFFECT_NOT_FOUND", effect_id: effectId });
      process.exit(1);
    }
    print({ ok: true, effect });
    return;
  }

  const operationByCommand: Record<string, RuntimeEffectRecoveryOperation> = {
    retry: "retry",
    cancel: "cancel",
    "dead-letter": "dead_letter",
  };
  const operation = operationByCommand[command];
  if (!operation || !effectId) usage();

  const receipt = await recoverRuntimeEffect(effectId, {
    operation,
    actor: actor(rest),
    reason: reason(rest),
    source: "cli:runtime-effect-recovery",
  });
  print({ ok: true, receipt });
}

main().catch((e) => {
  print({
    ok: false,
    error: e.code ?? "RUNTIME_EFFECT_RECOVERY_CLI_FAILED",
    message: e.message ?? String(e),
    details: e.details,
  });
  process.exit(e.status && e.status >= 400 ? 1 : 2);
});
