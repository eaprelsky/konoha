import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  runActionScenario,
  type ActionScenarioResult,
  type ActionScenarioStep,
} from "./action-harness";

export interface SavedActionScenario {
  id: string;
  title: string;
  steps: ActionScenarioStep[];
  tags: string[];
  created_at: string;
  stop_on_failure?: boolean;
}

export interface SaveActionScenarioInput {
  id: string;
  title: string;
  steps: ActionScenarioStep[];
  tags?: string[];
  stop_on_failure?: boolean;
}

export interface ReplaySavedScenarioInput {
  id: string;
  base_url: string;
  token?: string;
  fetch_impl?: typeof fetch;
  catalog_dir?: string;
}

export interface SavedScenarioRun {
  run_id: string;
  scenario_id: string;
  saved_at: string;
  result: ActionScenarioResult;
}

const DEFAULT_CATALOG_DIR = process.env.TESTBENCH_SCENARIO_DIR || "/opt/shared/konoha-testbench/action-scenarios";

export function defaultScenarioCatalogDir(): string {
  return DEFAULT_CATALOG_DIR;
}

export function saveActionScenario(
  input: SaveActionScenarioInput,
  catalogDir = DEFAULT_CATALOG_DIR,
): SavedActionScenario {
  validateScenarioInput(input);
  ensureCatalogDirs(catalogDir);
  const scenario: SavedActionScenario = {
    id: input.id,
    title: input.title.trim(),
    steps: input.steps,
    tags: input.tags ?? [],
    created_at: new Date().toISOString(),
    ...(input.stop_on_failure === undefined ? {} : { stop_on_failure: input.stop_on_failure }),
  };
  writeFileSync(scenarioPath(catalogDir, scenario.id), JSON.stringify(scenario, null, 2));
  return scenario;
}

export function listActionScenarios(catalogDir = DEFAULT_CATALOG_DIR): SavedActionScenario[] {
  ensureCatalogDirs(catalogDir);
  return readdirSync(catalogDir)
    .filter(name => name.endsWith(".json"))
    .map(name => readScenarioFile(join(catalogDir, name)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function getActionScenario(id: string, catalogDir = DEFAULT_CATALOG_DIR): SavedActionScenario | null {
  validateScenarioId(id);
  const path = scenarioPath(catalogDir, id);
  if (!existsSync(path)) return null;
  return readScenarioFile(path);
}

export async function replayActionScenario(
  input: ReplaySavedScenarioInput,
): Promise<SavedScenarioRun> {
  const scenario = getActionScenario(input.id, input.catalog_dir);
  if (!scenario) throw new Error(`scenario not found: ${input.id}`);

  const result = await runActionScenario({
    base_url: input.base_url,
    token: input.token,
    fetch_impl: input.fetch_impl,
    scenario: {
      name: scenario.title,
      steps: scenario.steps,
      stop_on_failure: scenario.stop_on_failure,
    },
  });

  const run: SavedScenarioRun = {
    run_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    scenario_id: scenario.id,
    saved_at: new Date().toISOString(),
    result,
  };
  ensureRunDir(input.catalog_dir ?? DEFAULT_CATALOG_DIR);
  writeFileSync(runPath(input.catalog_dir ?? DEFAULT_CATALOG_DIR, run.run_id), JSON.stringify(run, null, 2));
  return run;
}

export function listScenarioRuns(catalogDir = DEFAULT_CATALOG_DIR): SavedScenarioRun[] {
  ensureRunDir(catalogDir);
  return readdirSync(runDir(catalogDir))
    .filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(runDir(catalogDir), name), "utf-8")) as SavedScenarioRun)
    .sort((a, b) => a.saved_at.localeCompare(b.saved_at));
}

function validateScenarioInput(input: SaveActionScenarioInput): void {
  validateScenarioId(input.id);
  if (!input.title || typeof input.title !== "string") throw new Error("title required");
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error("steps must be a non-empty array");
  }
  for (const [index, step] of input.steps.entries()) {
    if (!step?.envelope?.action || typeof step.envelope.action !== "string") {
      throw new Error(`steps[${index}].envelope.action required`);
    }
  }
}

function validateScenarioId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new Error("scenario id must be 1-128 chars of letters, digits, dot, underscore, or dash");
  }
}

function readScenarioFile(path: string): SavedActionScenario {
  return JSON.parse(readFileSync(path, "utf-8")) as SavedActionScenario;
}

function ensureCatalogDirs(catalogDir: string): void {
  mkdirSync(catalogDir, { recursive: true });
  ensureRunDir(catalogDir);
}

function ensureRunDir(catalogDir: string): void {
  mkdirSync(runDir(catalogDir), { recursive: true });
}

function scenarioPath(catalogDir: string, id: string): string {
  return join(catalogDir, `${id}.json`);
}

function runDir(catalogDir: string): string {
  return join(catalogDir, "runs");
}

function runPath(catalogDir: string, runId: string): string {
  return join(runDir(catalogDir), `${runId}.json`);
}
