#!/usr/bin/env bun
import { readFileSync } from "fs";
import { join } from "path";

interface RuntimeIdMap {
  agents: Array<{ runtime_id: string }>;
}

interface Leak {
  path: string;
  id: string;
  line: number;
  text: string;
}

const ROOT = join(import.meta.dir, "..");
const PRODUCT_SURFACES = [
  "docs/guides/website-copy-workflow.md",
  "workflows/knowledge/intake.json",
  "workflows/knowledge/source-classification.json",
  "workflows/operations/bitrix-monitor.json",
  "workflows/reliability/incident-triage.json",
  "workflows/reliability/retention-cleanup.json",
  "workflows/sales/lead-qualification.json",
  "workflows/sdd/harness-factory.json",
];

const ALLOWLIST = new Set([
  "docs/guides/website-copy-workflow.md:kakashi:58:compatibility command documented until SDD delegation syntax is migrated",
]);

function readRuntimeIds(): string[] {
  const raw = readFileSync(join(ROOT, "docs/runtime-id-compatibility-map.json"), "utf-8");
  const map = JSON.parse(raw) as RuntimeIdMap;
  return map.agents.map(agent => agent.runtime_id).sort((a, b) => b.length - a.length);
}

export function findRuntimeIdProductLeaks(
  runtimeIds = readRuntimeIds(),
  productSurfaces = PRODUCT_SURFACES,
): Leak[] {
  const idPattern = new RegExp(`\\b(${runtimeIds.join("|")})\\b`, "g");
  const leaks: Leak[] = [];

  for (const path of productSurfaces) {
    const text = readFileSync(join(ROOT, path), "utf-8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const match of line.matchAll(idPattern)) {
        const id = match[1];
        const allowPrefix = `${path}:${id}:${i + 1}:`;
        if ([...ALLOWLIST].some(entry => entry.startsWith(allowPrefix))) continue;
        leaks.push({ path, id, line: i + 1, text: line.trim() });
      }
    }
  }

  return leaks;
}

if (import.meta.main) {
  const leaks = findRuntimeIdProductLeaks();
  if (leaks.length > 0) {
    console.error("Runtime IDs leaked into product surfaces:");
    for (const leak of leaks) {
      console.error(`- ${leak.path}:${leak.line}: ${leak.id}: ${leak.text}`);
    }
    process.exit(1);
  }
  console.log("runtime id product-surface leak check OK");
}
