#!/usr/bin/env bun
import {
  buildPgReadReadinessReport,
  renderPgReadReadinessReportText,
} from "../src/pg-read-readiness";

async function main() {
  const json = process.argv.includes("--json");
  const report = await buildPgReadReadinessReport();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderPgReadReadinessReportText(report));
  }

  process.exit(report.overall_status === "ready" ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
