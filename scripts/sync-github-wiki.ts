#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

export const DEFAULT_WIKI_SOURCE_DIR = "docs/wiki";
export const REQUIRED_WIKI_PAGES = [
  "Home.md",
  "Quickstart.md",
  "Core-Concepts.md",
  "AI-Constructor.md",
  "Architecture-Overview.md",
  "Operator-Handbook.md",
  "Tutorials.md",
  "Roadmap.md",
  "FAQ-Troubleshooting.md",
  "Public-Documentation-Policy.md",
  "_Sidebar.md",
] as const;

const FORBIDDEN_PATH_SEGMENTS = [
  "agent-memory",
  "jiraiya",
  ".env",
  "logs",
  "runtime",
] as const;

const FORBIDDEN_CONTENT_PATTERNS: Array<{ id: string; pattern: RegExp; message: string }> = [
  { id: "agent-memory", pattern: /\/opt\/shared\/agent-memory|agent-memory/i, message: "agent memory must not be published" },
  { id: "jiraiya", pattern: /\bjiraiya\b/i, message: "Jiraiya classification dumps must not be published" },
  { id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, message: "private keys must not be published" },
  { id: "github-token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/, message: "GitHub tokens must not be published" },
  { id: "openai-token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, message: "LLM API keys must not be published" },
  { id: "telegram-token", pattern: /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/, message: "Telegram bot tokens must not be published" },
  { id: "secret-assignment", pattern: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*['"]?[A-Za-z0-9_./:+-]{8,}/, message: "secret-looking assignments must use placeholders" },
  { id: "production-workdir", pattern: /\/opt\/shared\/agent-workdirs|\/home\/ubuntu\/\.agent-env|\/opt\/shared\/\.shared-credentials/i, message: "private production paths must not be published" },
  { id: "raw-log", pattern: /\bSESSION_(?:ONLINE|OFFLINE):|watchdog delivery|tmux session/i, message: "raw operational logs must not be published" },
];

export interface WikiPage {
  sourcePath: string;
  wikiPath: string;
  title: string;
}

export interface WikiCheckReport {
  sourceDir: string;
  pageCount: number;
  pages: WikiPage[];
  requiredPages: string[];
  forbiddenPathSegments: readonly string[];
  forbiddenContentPatternIds: string[];
}

export function defaultWikiUrl(repository = process.env.GITHUB_REPOSITORY || "eaprelsky/konoha"): string {
  return `https://github.com/${repository}.wiki.git`;
}

function fail(message: string): never {
  throw new Error(message);
}

function isMarkdownFile(path: string): boolean {
  return path.endsWith(".md");
}

function validateRelativeWikiPath(path: string): void {
  if (path.startsWith("..") || path.includes("\0")) {
    fail(`Invalid wiki path outside source tree: ${path}`);
  }
  if (!isMarkdownFile(path)) {
    fail(`Only Markdown files can be published to the Wiki: ${path}`);
  }
  if (!/^[A-Za-z0-9._/-]+\.md$/.test(path)) {
    fail(`Wiki filenames must be URL-safe ASCII Markdown paths: ${path}`);
  }
  const lowered = path.toLowerCase();
  for (const segment of FORBIDDEN_PATH_SEGMENTS) {
    if (lowered.split("/").includes(segment)) {
      fail(`Forbidden private path segment in Wiki source: ${path}`);
    }
  }
}

async function listMarkdownFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(root, full));
    } else if (entry.isFile()) {
      const rel = relative(root, full).replaceAll("\\", "/");
      validateRelativeWikiPath(rel);
      files.push(rel);
    }
  }
  return files.sort();
}

function extractTitle(content: string, fallback: string): string {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return title || fallback.replace(/\.md$/, "").replaceAll("-", " ");
}

function validatePublicContent(path: string, content: string): void {
  for (const forbidden of FORBIDDEN_CONTENT_PATTERNS) {
    if (forbidden.pattern.test(content)) {
      fail(`${path}: ${forbidden.message} (${forbidden.id})`);
    }
  }
}

export async function checkWikiSource(sourceDir = DEFAULT_WIKI_SOURCE_DIR): Promise<WikiCheckReport> {
  const root = resolve(sourceDir);
  if (!existsSync(root)) fail(`Wiki source directory does not exist: ${sourceDir}`);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) fail(`Wiki source path is not a directory: ${sourceDir}`);

  const markdownFiles = await listMarkdownFiles(root);
  const missing = REQUIRED_WIKI_PAGES.filter(page => !markdownFiles.includes(page));
  if (missing.length > 0) fail(`Missing required Wiki pages: ${missing.join(", ")}`);

  const pages: WikiPage[] = [];
  for (const file of markdownFiles) {
    const content = await readFile(join(root, file), "utf-8");
    validatePublicContent(file, content);
    pages.push({
      sourcePath: `${sourceDir.replace(/\/$/, "")}/${file}`,
      wikiPath: file,
      title: extractTitle(content, basename(file)),
    });
  }

  return {
    sourceDir,
    pageCount: pages.length,
    pages,
    requiredPages: [...REQUIRED_WIKI_PAGES],
    forbiddenPathSegments: FORBIDDEN_PATH_SEGMENTS,
    forbiddenContentPatternIds: FORBIDDEN_CONTENT_PATTERNS.map(pattern => pattern.id),
  };
}

async function emptyDirectoryExceptGit(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) {
    if (entry === ".git") continue;
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}

export async function renderWikiSource(sourceDir: string, outputDir: string): Promise<WikiCheckReport> {
  const report = await checkWikiSource(sourceDir);
  const root = resolve(sourceDir);
  await emptyDirectoryExceptGit(outputDir);
  for (const page of report.pages) {
    const destination = join(outputDir, page.wikiPath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, page.wikiPath), destination);
  }
  await writeFile(join(outputDir, ".nojekyll"), "Generated from docs/wiki/ in the main Konoha repository.\n");
  return report;
}

function runGit(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    fail(`git ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
  }
}

function withToken(url: string, token?: string): string {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

export interface PublishWikiOptions {
  sourceDir?: string;
  wikiUrl?: string;
  workDir?: string;
  token?: string;
  dryRun?: boolean;
}

export async function publishWiki(options: PublishWikiOptions = {}): Promise<WikiCheckReport & { committed: boolean; pushed: boolean }> {
  const sourceDir = options.sourceDir || DEFAULT_WIKI_SOURCE_DIR;
  const wikiUrl = options.wikiUrl || defaultWikiUrl();
  const workDir = options.workDir || await mkdtemp(join(tmpdir(), "konoha-wiki-"));
  const cloneDir = join(workDir, "wiki");
  const authUrl = withToken(wikiUrl, options.token || process.env.GITHUB_TOKEN);

  const clone = spawnSync("git", ["clone", authUrl, cloneDir], { stdio: "pipe", encoding: "utf-8" });
  if (clone.status !== 0) {
    await mkdir(cloneDir, { recursive: true });
    runGit(["init"], cloneDir);
    runGit(["remote", "add", "origin", authUrl], cloneDir);
  }

  runGit(["checkout", "-B", "master"], cloneDir);
  const report = await renderWikiSource(sourceDir, cloneDir);
  runGit(["add", "-A"], cloneDir);

  const status = spawnSync("git", ["status", "--porcelain"], { cwd: cloneDir, stdio: "pipe", encoding: "utf-8" });
  const hasChanges = Boolean(status.stdout.trim());
  if (!hasChanges) return { ...report, committed: false, pushed: false };

  if (options.dryRun) return { ...report, committed: false, pushed: false };

  runGit(["commit", "-m", "Sync public Konoha Wiki"], cloneDir);
  runGit(["push", "-u", "origin", "master"], cloneDir);
  return { ...report, committed: true, pushed: true };
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/sync-github-wiki.ts --check [--source docs/wiki]
  bun run scripts/sync-github-wiki.ts --dry-run [--source docs/wiki] [--out /tmp/wiki]
  bun run scripts/sync-github-wiki.ts --publish [--source docs/wiki] [--wiki-url https://github.com/eaprelsky/konoha.wiki.git]
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    printUsage();
    return;
  }

  const getArg = (name: string, fallback?: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const sourceDir = getArg("--source", DEFAULT_WIKI_SOURCE_DIR)!;

  if (args.includes("--check")) {
    const report = await checkWikiSource(sourceDir);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.includes("--dry-run")) {
    const out = getArg("--out") || await mkdtemp(join(tmpdir(), "konoha-wiki-render-"));
    const report = await renderWikiSource(sourceDir, out);
    console.log(JSON.stringify({ ...report, outputDir: out }, null, 2));
    return;
  }

  if (args.includes("--publish")) {
    const report = await publishWiki({
      sourceDir,
      wikiUrl: getArg("--wiki-url"),
      token: process.env.GITHUB_TOKEN,
      dryRun: false,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printUsage();
  process.exitCode = 2;
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
