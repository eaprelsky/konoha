#!/usr/bin/env bun
import {
  evaluateBpmsObservation,
  findBpmsLoadProfile,
  loadBpmsLoadCatalog,
  loadBpmsObservation,
  loadResourceBudgetContract,
  validateBpmsLoadCatalog,
  writeBpmsRegressionReport,
} from "../src/bpms-load-regression";

interface CliArgs {
  catalog: string;
  budgets: string;
  profile?: string;
  observations?: string;
  report?: string;
  checkOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    catalog: "docs/bpms-load-profiles.json",
    budgets: "docs/resource-budgets.json",
    checkOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--catalog" && next) {
      args.catalog = next;
      i += 1;
    } else if (arg === "--budgets" && next) {
      args.budgets = next;
      i += 1;
    } else if (arg === "--profile" && next) {
      args.profile = next;
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
  bun run scripts/bpms-load-regression.ts --check
  bun run scripts/bpms-load-regression.ts --profile ci-bpms-regression --observations tests/fixtures/bpms-load/ci-passing.json --report /tmp/bpms-load-regression-report.json
`);
}

function main(): void {
  const args = parseArgs(Bun.argv.slice(2));
  const catalog = loadBpmsLoadCatalog(args.catalog);
  const budgets = loadResourceBudgetContract(args.budgets);
  const errors = validateBpmsLoadCatalog(catalog, budgets);
  if (errors.length > 0) {
    for (const error of errors) console.error(`BPMS load profile error: ${error}`);
    process.exit(1);
  }

  if (args.checkOnly) {
    console.log(`BPMS load catalog OK: ${catalog.profiles.length} profiles`);
    return;
  }

  if (!args.profile || !args.observations || !args.report) {
    throw new Error("--profile, --observations, and --report are required unless --check is used");
  }

  const profile = findBpmsLoadProfile(catalog, args.profile);
  const observation = loadBpmsObservation(args.observations);
  if (observation.profile_id !== profile.id) {
    throw new Error(`Observation profile_id=${observation.profile_id} does not match --profile=${profile.id}`);
  }

  const report = evaluateBpmsObservation(catalog, observation);
  writeBpmsRegressionReport(args.report, report);
  console.log(`BPMS load regression ${report.status}: ${profile.id} -> ${args.report}`);
  if (report.status !== "pass") {
    for (const check of report.checks.filter(check => check.status === "fail")) {
      console.error(`${check.name}: actual=${check.actual} limit=${check.limit}`);
    }
    process.exit(1);
  }
}

main();
