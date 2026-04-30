#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import ts from "typescript";

export interface I18nFinding {
  id: string;
  file: string;
  line: number;
  kind: "jsx_text" | "string" | "template";
  text: string;
}

interface GuardOptions {
  root?: string;
  files?: string[];
}

const DEFAULT_ROOT = "frontend/src";
const DEFAULT_GUARDED_FILES = [
  "frontend/src/pages/ByProcessView.tsx",
  "frontend/src/pages/BySourceView.tsx",
  "frontend/src/pages/Cases.tsx",
  "frontend/src/pages/Dashboard.tsx",
  "frontend/src/pages/EventCard.tsx",
  "frontend/src/pages/EventMonitor.tsx",
  "frontend/src/pages/Monitor.tsx",
  "frontend/src/pages/TimelineView.tsx",
  "frontend/src/pages/WorkItems.tsx",
  "frontend/src/pages/eventMonitorUtils.ts",
] as const;
const CYRILLIC_RE = /[А-Яа-яЁё]/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hasCyrillic(text: string): boolean {
  return CYRILLIC_RE.test(text);
}

function isAllowedLocation(file: string): boolean {
  const normalized = posixPath(file);
  return normalized === "frontend/src/i18n/translations.ts"
    || normalized.endsWith("/frontend/src/i18n/translations.ts")
    || normalized.includes("/__tests__/")
    || normalized.endsWith(".test.ts")
    || normalized.endsWith(".test.tsx");
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = entry.name.endsWith(".tsx") ? ".tsx" : entry.name.endsWith(".ts") ? ".ts" : "";
      if (SOURCE_EXTENSIONS.has(ext)) out.push(full);
    }
  }
  walk(root);
  return out.sort();
}

function findingId(file: string, kind: I18nFinding["kind"], text: string): string {
  return `${file}::${kind}::${normalizeText(text)}`;
}

function sourceKind(filename: string): ts.ScriptKind {
  return filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function matchesGuardedFile(absPath: string, root: string, guardedFiles: string[]): boolean {
  const fromCwd = posixPath(relative(process.cwd(), absPath));
  const fromRoot = posixPath(relative(root, absPath));
  const fromDefaultRoot = posixPath(join(DEFAULT_ROOT, fromRoot));
  return guardedFiles.some(file => {
    const normalized = posixPath(file);
    return normalized === fromCwd || normalized === fromRoot || normalized === fromDefaultRoot;
  });
}

function collectText(source: ts.SourceFile, file: string, node: ts.Node, kind: I18nFinding["kind"], raw: string, findings: Map<string, I18nFinding>) {
  const text = normalizeText(raw);
  if (!text || !hasCyrillic(text)) return;
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  const id = findingId(file, kind, text);
  if (!findings.has(id)) {
    findings.set(id, { id, file, line: line + 1, kind, text });
  }
}

function scanFile(absPath: string, relFile: string): I18nFinding[] {
  if (isAllowedLocation(relFile)) return [];
  const source = ts.createSourceFile(
    relFile,
    readFileSync(absPath, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    sourceKind(relFile),
  );
  const findings = new Map<string, I18nFinding>();

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) {
      collectText(source, relFile, node, "jsx_text", node.getText(source), findings);
    } else if (ts.isStringLiteralLike(node)) {
      collectText(source, relFile, node, "string", node.text, findings);
    } else if (ts.isTemplateExpression(node)) {
      collectText(source, relFile, node, "template", node.head.text, findings);
      for (const span of node.templateSpans) {
        collectText(source, relFile, span.literal, "template", span.literal.text, findings);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return [...findings.values()];
}

export function scanFrontendI18nLiterals(root = DEFAULT_ROOT, guardedFiles?: string[]): I18nFinding[] {
  if (!existsSync(root)) throw new Error(`Scan root does not exist: ${root}`);
  return walkFiles(root)
    .filter(absPath => !guardedFiles || matchesGuardedFile(absPath, root, guardedFiles))
    .flatMap(absPath => scanFile(absPath, posixPath(relative(process.cwd(), absPath))))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.text.localeCompare(b.text));
}

export function runI18nGuard(options: GuardOptions = {}) {
  const root = options.root ?? DEFAULT_ROOT;
  const guardedFiles = options.files ?? [...DEFAULT_GUARDED_FILES];
  const findings = scanFrontendI18nLiterals(root, guardedFiles);
  return { findings, violations: findings, guardedFiles };
}

function printFinding(finding: I18nFinding) {
  console.error(`- ${finding.file}:${finding.line} [${finding.kind}] ${JSON.stringify(finding.text)}`);
}

function main() {
  const rootArg = process.argv.find(arg => arg.startsWith("--root="));
  const filesArg = process.argv.find(arg => arg.startsWith("--files="));
  const result = runI18nGuard({
    root: rootArg ? rootArg.slice("--root=".length) : DEFAULT_ROOT,
    files: filesArg ? filesArg.slice("--files=".length).split(",").filter(Boolean) : undefined,
  });

  if (result.violations.length > 0) {
    console.error(`Found ${result.violations.length} hardcoded localized frontend string(s) in guarded operator/demo files.`);
    console.error("Move product copy to frontend/src/i18n/translations.ts and use useI18n().t(...). Keep legacy migration outside this scoped guard.");
    for (const finding of result.violations.slice(0, 50)) printFinding(finding);
    if (result.violations.length > 50) console.error(`... ${result.violations.length - 50} more`);
    process.exit(1);
  }

  console.log(`i18n hardcoded-copy guard passed: ${result.guardedFiles.length} guarded operator/demo file(s), 0 violation(s).`);
}

if (import.meta.main) {
  main();
}
