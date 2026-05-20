#!/usr/bin/env bun
/**
 * Public task/session MCP config entrypoint.
 *
 * Persistent agent startup intentionally uses mode=startup. This script is the
 * bounded task/session contract: KONOHA_MCP_SESSION_PACKS selects lazy packs,
 * the generated receipt records which packs were included/deferred/skipped, and
 * on-demand stdio packs are wrapped with an idle timeout.
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  buildMcpConfigWithReceipt,
  resolveSharedMcpAllowlist,
} from "../src/agent";

type Args = {
  allowlist?: string[];
  toolProfile?: string;
  capabilities: string[];
  configOut?: string;
  receiptOut?: string;
};

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { capabilities: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--allowlist") {
      args.allowlist = parseCsv(value);
      i += 1;
      continue;
    }
    if (flag === "--tool-profile") {
      args.toolProfile = value;
      i += 1;
      continue;
    }
    if (flag === "--capabilities") {
      args.capabilities = parseCsv(value);
      i += 1;
      continue;
    }
    if (flag === "--config-out") {
      args.configOut = value;
      i += 1;
      continue;
    }
    if (flag === "--receipt-out") {
      args.receiptOut = value;
      i += 1;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      printUsage(0);
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function printUsage(exitCode: number): never {
  console.log(`Usage:
  KONOHA_MCP_SESSION_PACKS=puppeteer bun scripts/build-mcp-session-config.ts \\
    --allowlist puppeteer \\
    --config-out /tmp/session.mcp.json \\
    --receipt-out /tmp/session.mcp-receipt.json

Options:
  --allowlist       Comma-separated shared MCP servers to allow.
  --tool-profile    Tool profile id used when --allowlist is omitted.
  --capabilities    Comma-separated Konoha MCP skill ids.
  --config-out      Write generated MCP config JSON to this path.
  --receipt-out     Write MCP pack receipt JSON to this path.
`);
  process.exit(exitCode);
}

try {
  const args = parseArgs(Bun.argv.slice(2));
  const allowlist = resolveSharedMcpAllowlist(args.allowlist, args.toolProfile);
  const result = await buildMcpConfigWithReceipt(
    args.capabilities,
    process.env as Record<string, string>,
    allowlist,
    { mode: "task" },
  );

  if (args.configOut) writeJson(args.configOut, result.config);
  if (args.receiptOut) writeJson(args.receiptOut, result.receipt);
  if (!args.configOut && !args.receiptOut) {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
