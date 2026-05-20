#!/usr/bin/env bun
/**
 * Stdio MCP idle wrapper.
 *
 * Runs an on-demand MCP server and exits after a period with no input from the
 * parent client. This keeps task/session MCP packs from staying resident after
 * the task that requested them is done.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";

type ResourceOptions = {
  scopeUnit?: string;
  slice?: string;
  memoryHigh?: string;
  memoryMax?: string;
  cpuWeight?: string;
  cpuQuota?: string;
  tasksMax?: string;
};

function parseArgs(argv: string[]): { timeoutSec: number; resources: ResourceOptions; command: string; args: string[] } {
  const sep = argv.indexOf("--");
  if (sep < 0) throw new Error("usage: mcp-idle-wrapper.ts --timeout-sec N -- <command> [args...]");
  const before = argv.slice(0, sep);
  const commandAndArgs = argv.slice(sep + 1);
  if (commandAndArgs.length === 0) throw new Error("missing wrapped MCP command");
  let timeoutSec = 900;
  const resources: ResourceOptions = {};
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] === "--timeout-sec") {
      const parsed = Number.parseInt(before[i + 1] || "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("invalid --timeout-sec value");
      timeoutSec = parsed;
      i += 1;
      continue;
    }
    if (before[i] === "--scope-unit") {
      resources.scopeUnit = before[i + 1];
      i += 1;
      continue;
    }
    if (before[i] === "--slice") {
      resources.slice = before[i + 1];
      i += 1;
      continue;
    }
    if (before[i] === "--memory-high") {
      resources.memoryHigh = before[i + 1];
      i += 1;
      continue;
    }
    if (before[i] === "--memory-max") {
      resources.memoryMax = before[i + 1];
      i += 1;
      continue;
    }
    if (before[i] === "--cpu-weight") {
      resources.cpuWeight = before[i + 1];
      i += 1;
      continue;
    }
    if (before[i] === "--cpu-quota") {
      resources.cpuQuota = before[i + 1];
      i += 1;
      continue;
    }
    if (before[i] === "--tasks-max") {
      resources.tasksMax = before[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`unknown option before --: ${before[i]}`);
  }
  return { timeoutSec, resources, command: commandAndArgs[0], args: commandAndArgs.slice(1) };
}

function systemdScopeEnabled(): boolean {
  const raw = (process.env.KONOHA_MCP_SYSTEMD_SCOPE || "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(raw)) return false;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  return process.platform === "linux" && existsSync("/run/systemd/system");
}

function scopedLaunch(command: string, args: string[], resources: ResourceOptions): { command: string; args: string[] } {
  if (!resources.scopeUnit || !systemdScopeEnabled()) return { command, args };
  const scopedArgs = [
    "-n",
    "systemd-run",
    "--scope",
    "--quiet",
    "--collect",
    `--unit=${resources.scopeUnit}`,
    ...(resources.slice ? [`--slice=${resources.slice}`] : []),
    "--uid=ubuntu",
    "--gid=ubuntu",
    ...(resources.memoryHigh ? [`--property=MemoryHigh=${resources.memoryHigh}`] : []),
    ...(resources.memoryMax ? [`--property=MemoryMax=${resources.memoryMax}`] : []),
    ...(resources.cpuWeight ? [`--property=CPUWeight=${resources.cpuWeight}`] : []),
    ...(resources.cpuQuota ? [`--property=CPUQuota=${resources.cpuQuota}`] : []),
    ...(resources.tasksMax ? [`--property=TasksMax=${resources.tasksMax}`] : []),
    "--",
    command,
    ...args,
  ];
  return { command: "sudo", args: scopedArgs };
}

const { timeoutSec, resources, command, args } = parseArgs(Bun.argv.slice(2));
const launch = scopedLaunch(command, args, resources);
const child = spawn(launch.command, launch.args, {
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
