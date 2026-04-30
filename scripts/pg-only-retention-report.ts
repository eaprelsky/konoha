#!/usr/bin/env bun
import { buildPgOnlyRetentionReport, renderRetentionReportText } from "../src/retention/report";

function parseLimit(): number | null {
  if (process.argv.includes("--all")) return null;
  const arg = process.argv.find(value => value.startsWith("--limit="));
  if (!arg) return 120;
  const n = Number(arg.slice("--limit=".length));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 120;
}

async function main() {
  const json = process.argv.includes("--json");
  const report = await buildPgOnlyRetentionReport();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderRetentionReportText(report, parseLimit()));
  }

  process.exit(report.hard_fail ? 1 : 0);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
