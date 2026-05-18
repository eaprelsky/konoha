#!/usr/bin/env bun
import {
  evaluateDataStoreDrill,
  loadDataStoreDrillContract,
  loadDataStoreDrillObservation,
  validateDataStoreDrillContract,
  writeDataStoreDrillReport,
} from "../src/data-store-drill";

interface CliArgs {
  contract: string;
  observations?: string;
  report?: string;
  checkOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    contract: "docs/data-store-drill.json",
    checkOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--contract" && next) {
      args.contract = next;
      i += 1;
    } else if (arg === "--observations" && next) {
      args.observations = next;
      i += 1;
    } else if (arg === "--report" && next) {
      args.report = next;
      i += 1;
    } else if (arg === "--check") {
      args.checkOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Usage:
  bun run scripts/data-store-drill.ts --check
  bun run scripts/data-store-drill.ts --observations tests/fixtures/data-store-drill/staging-passing.json --report /tmp/konoha-data-store-drill-report.json
`);
}

function main(): void {
  const args = parseArgs(Bun.argv.slice(2));
  const contract = loadDataStoreDrillContract(args.contract);
  const errors = validateDataStoreDrillContract(contract);
  if (errors.length > 0) {
    for (const error of errors) console.error(`Data-store drill contract error: ${error}`);
    process.exit(1);
  }

  if (args.checkOnly) {
    console.log(`Konoha data-store drill contract OK: ${contract.data_stores.length} targets`);
    return;
  }

  if (!args.observations || !args.report) {
    throw new Error("--observations and --report are required unless --check is used");
  }

  const observation = loadDataStoreDrillObservation(args.observations);
  const report = evaluateDataStoreDrill(contract, observation);
  writeDataStoreDrillReport(args.report, report);
  console.log(`Konoha data-store drill ${report.status}: ${observation.drill_id} -> ${args.report}`);
  if (report.status !== "pass") {
    for (const check of report.checks.filter(check => check.status === "fail")) {
      console.error(`${check.name}: ${check.detail}`);
    }
    process.exit(1);
  }
}

main();
