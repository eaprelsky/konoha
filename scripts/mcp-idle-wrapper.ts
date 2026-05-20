#!/usr/bin/env bun
/**
 * Stdio MCP idle wrapper.
 *
 * Runs an on-demand MCP server and exits after a period with no input from the
 * parent client. This keeps task/session MCP packs from staying resident after
 * the task that requested them is done.
 */

import { spawn } from "child_process";

function parseArgs(argv: string[]): { timeoutSec: number; command: string; args: string[] } {
  const sep = argv.indexOf("--");
  if (sep < 0) throw new Error("usage: mcp-idle-wrapper.ts --timeout-sec N -- <command> [args...]");
  const before = argv.slice(0, sep);
  const commandAndArgs = argv.slice(sep + 1);
  if (commandAndArgs.length === 0) throw new Error("missing wrapped MCP command");
  let timeoutSec = 900;
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] === "--timeout-sec") {
      const parsed = Number.parseInt(before[i + 1] || "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("invalid --timeout-sec value");
      timeoutSec = parsed;
      i += 1;
    }
  }
  return { timeoutSec, command: commandAndArgs[0], args: commandAndArgs.slice(1) };
}

const { timeoutSec, command, args } = parseArgs(Bun.argv.slice(2));
const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let exited = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function resetTimer(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (exited) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 5_000).unref();
  }, timeoutSec * 1_000);
  timer.unref();
}

resetTimer();

process.stdin.on("data", chunk => {
  resetTimer();
  child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());
process.stdin.on("error", () => child.stdin.destroy());

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on("exit", code => {
  exited = true;
  if (timer) clearTimeout(timer);
  process.exit(code ?? 0);
});
child.on("error", error => {
  exited = true;
  if (timer) clearTimeout(timer);
  console.error(`[mcp-idle-wrapper] ${error.message}`);
  process.exit(1);
});
