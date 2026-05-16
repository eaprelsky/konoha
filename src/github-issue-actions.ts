import { execFileSync } from "child_process";

export interface GithubIssueActionOptions {
  runner?: (args: string[]) => string;
}

export interface GithubIssueCommandPreview {
  dry_run: true;
  command: string[];
}

const DEFAULT_REPO = "eaprelsky/konoha";

function ghToken(): string {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

function defaultRunner(args: string[]): string {
  const token = ghToken();
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, GH_TOKEN: token, no_proxy: "127.0.0.1,localhost", NO_PROXY: "127.0.0.1,localhost" },
  }).trim();
}

function repoArg(repo: unknown): string {
  return typeof repo === "string" && repo.trim() ? repo.trim() : process.env.KONOHA_REPO || DEFAULT_REPO;
}

function issueNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error("issue_number must be a positive integer");
  return String(n);
}

function stringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("expected array");
  return value.map(String).map(s => s.trim()).filter(Boolean);
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e: any) {
    throw new Error(`GitHub CLI returned invalid JSON: ${e.message}`);
  }
}

function preview(args: string[]): GithubIssueCommandPreview {
  return { dry_run: true, command: ["gh", ...args] };
}

function run(args: string[], dryRun: boolean, opts: GithubIssueActionOptions): string | GithubIssueCommandPreview {
  if (dryRun) return preview(args);
  return (opts.runner ?? defaultRunner)(args);
}

export async function executeGithubIssueAction(
  action: string,
  args: Record<string, unknown>,
  opts: GithubIssueActionOptions = {},
): Promise<{ status: number; data: unknown } | null> {
  const repo = repoArg(args.repo);
  const dryRun = args.dry_run === true;

  switch (action) {
    case "issue.get": {
      const cmd = [
        "issue", "view", issueNumber(args.issue_number),
        "--repo", repo,
        "--json", "number,title,state,labels,body,comments,author,createdAt,updatedAt,url",
      ];
      const out = run(cmd, dryRun, opts);
      return { status: 200, data: typeof out === "string" ? parseJson(out) : out };
    }

    case "issue.list": {
      const cmd = ["issue", "list", "--repo", repo, "--state", String(args.state ?? "open")];
      for (const label of stringArray(args.labels)) cmd.push("--label", label);
      if (args.limit !== undefined) cmd.push("--limit", String(args.limit));
      cmd.push("--json", "number,title,state,labels,author,createdAt,updatedAt,url");
      const out = run(cmd, dryRun, opts);
      return { status: 200, data: typeof out === "string" ? parseJson(out) : out };
    }

    case "issue.comment": {
      const body = typeof args.body === "string" ? args.body : "";
      if (!body.trim()) return { status: 400, data: { error: "body is required" } };
      const cmd = ["issue", "comment", issueNumber(args.issue_number), "--repo", repo, "--body", body];
      const out = run(cmd, dryRun, opts);
      return { status: 200, data: typeof out === "string" ? { url: out } : out };
    }

    case "issue.update_labels": {
      const add = stringArray(args.add_labels);
      const remove = stringArray(args.remove_labels);
      if (add.length === 0 && remove.length === 0) {
        return { status: 400, data: { error: "add_labels or remove_labels required" } };
      }
      const cmd = ["issue", "edit", issueNumber(args.issue_number), "--repo", repo];
      for (const label of add) cmd.push("--add-label", label);
      for (const label of remove) cmd.push("--remove-label", label);
      const out = run(cmd, dryRun, opts);
      return { status: 200, data: typeof out === "string" ? { url: out } : out };
    }

    case "issue.close": {
      const cmd = ["issue", "close", issueNumber(args.issue_number), "--repo", repo];
      if (typeof args.comment === "string" && args.comment.trim()) cmd.push("--comment", args.comment);
      const out = run(cmd, dryRun, opts);
      return { status: 200, data: typeof out === "string" ? { output: out } : out };
    }

    default:
      return null;
  }
}
