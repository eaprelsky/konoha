#!/usr/bin/env bun
import { execFileSync } from "child_process";

export interface MergeReportInput {
  branch: string;
  base: string;
  head: string;
  statusShort: string;
  ahead: number;
  behind: number;
  changedFiles: string[];
  checks: string[];
  risks: string[];
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf-8" }).trim();
}

function parseArgs(argv: string[]): { base: string; checks: string[]; risks: string[] } {
  const result = { base: "origin/main", checks: [] as string[], risks: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") result.base = argv[++i] ?? result.base;
    else if (arg === "--checks") result.checks.push(argv[++i] ?? "");
    else if (arg === "--risk") result.risks.push(argv[++i] ?? "");
  }
  return result;
}

function revListCount(range: string): number {
  const out = git(["rev-list", "--count", range]);
  return Number(out || 0);
}

function splitLines(value: string): string[] {
  return value ? value.split("\n").filter(Boolean) : [];
}

export function renderMergeReadinessReport(input: MergeReportInput): string {
  const checks = input.checks.length ? input.checks : ["not provided"];
  const risks = input.risks.length ? input.risks : ["none reported"];
  const files = input.changedFiles.length ? input.changedFiles : ["none"];
  return [
    "## Merge readiness report",
    "",
    `Branch: ${input.branch}`,
    `Base: ${input.base}`,
    `HEAD: ${input.head}`,
    `Ahead/behind: +${input.ahead} / -${input.behind}`,
    "",
    "State: review_required",
    "",
    "Changed files:",
    ...files.map(file => `- ${file}`),
    "",
    "Checks:",
    ...checks.map(check => `- ${check}`),
    "",
    "Risks/questions:",
    ...risks.map(risk => `- ${risk}`),
    "",
    "Gate:",
    "- No push to main performed.",
    "- Reviewer must add merge:ready before integration.",
    "",
  ].join("\n");
}

export function collectMergeReportInput(argv: string[]): MergeReportInput {
  const { base, checks, risks } = parseArgs(argv);
  const branch = git(["branch", "--show-current"]);
  if (branch === "main") {
    throw new Error("Refusing to generate merge readiness report on main");
  }
  const head = git(["rev-parse", "--short", "HEAD"]);
  const statusShort = git(["status", "--short", "--branch"]);
  const ahead = revListCount(`${base}..HEAD`);
  const behind = revListCount(`HEAD..${base}`);
  const changedFiles = [...new Set([
    ...splitLines(git(["diff", "--name-only", `${base}...HEAD`])),
    ...splitLines(git(["diff", "--name-only", "--cached"])),
    ...splitLines(git(["diff", "--name-only"])),
    ...splitLines(git(["ls-files", "--others", "--exclude-standard"])),
  ])].sort();
  return { branch, base, head, statusShort, ahead, behind, changedFiles, checks: checks.filter(Boolean), risks: risks.filter(Boolean) };
}

if (import.meta.main) {
  try {
    process.stdout.write(renderMergeReadinessReport(collectMergeReportInput(process.argv.slice(2))));
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}
