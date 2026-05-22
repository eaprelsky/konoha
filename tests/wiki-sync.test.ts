import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  REQUIRED_WIKI_PAGES,
  checkWikiSource,
  renderWikiSource,
} from "../scripts/sync-github-wiki";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("public GitHub Wiki source and sync policy", () => {
  test("defines the required public Wiki skeleton in docs/wiki", async () => {
    const report = await checkWikiSource("docs/wiki");
    const pages = report.pages.map(page => page.wikiPath).sort();

    expect(report.sourceDir).toBe("docs/wiki");
    expect(report.pageCount).toBeGreaterThanOrEqual(REQUIRED_WIKI_PAGES.length);
    for (const page of REQUIRED_WIKI_PAGES) {
      expect(pages).toContain(page);
    }
    expect(report.forbiddenContentPatternIds).toContain("agent-memory");
    expect(report.forbiddenContentPatternIds).toContain("secret-assignment");
    expect(report.forbiddenPathSegments).toContain("agent-memory");
  });

  test("sidebar links point to existing Wiki pages", async () => {
    const report = await checkWikiSource("docs/wiki");
    const pages = new Set(report.pages.map(page => page.wikiPath.replace(/\.md$/, "")));
    const sidebar = await readFile("docs/wiki/_Sidebar.md", "utf-8");
    const links = [...sidebar.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);

    expect(links.length).toBeGreaterThan(5);
    for (const link of links) {
      expect(pages.has(link), `${link} should exist as a Wiki page`).toBe(true);
    }
  });

  test("renders only reviewed docs/wiki Markdown into a Wiki checkout", async () => {
    const out = await makeTempDir("konoha-wiki-render-test-");
    const report = await renderWikiSource("docs/wiki", out);

    expect(report.pageCount).toBeGreaterThanOrEqual(REQUIRED_WIKI_PAGES.length);
    expect(existsSync(join(out, "Home.md"))).toBe(true);
    expect(existsSync(join(out, "_Sidebar.md"))).toBe(true);
    expect(existsSync(join(out, ".nojekyll"))).toBe(true);
    expect(existsSync(join(out, "agent-memory"))).toBe(false);
  });

  test("rejects private memory, production paths, and secret-looking assignments", async () => {
    const source = await makeTempDir("konoha-wiki-source-test-");
    await mkdir(source, { recursive: true });
    for (const page of REQUIRED_WIKI_PAGES) {
      await writeFile(join(source, page), `# ${page}\n\nPublic placeholder.\n`);
    }

    await writeFile(join(source, "Home.md"), "# Home\n\nDo not publish /opt/shared/agent-memory/MEMORY.md\n");
    await expect(checkWikiSource(source)).rejects.toThrow("agent memory");

    await writeFile(join(source, "Home.md"), "# Home\n\nKONOHA_TOKEN=real-looking-secret\n");
    await expect(checkWikiSource(source)).rejects.toThrow("secret-looking assignments");
  });

  test("README exposes the public Wiki as the human-friendly documentation entry point", async () => {
    const readme = await readFile("README.md", "utf-8");

    expect(readme).toContain("https://github.com/eaprelsky/konoha/wiki");
    expect(readme).toContain("docs/wiki/");
  });

  test("GitHub Action validates source and publishes only with a Wiki-capable token", async () => {
    const workflow = await readFile(".github/workflows/wiki.yml", "utf-8");

    expect(workflow).toContain("bun run scripts/sync-github-wiki.ts --check");
    expect(workflow).toContain("KONOHA_WIKI_TOKEN");
    expect(workflow).toContain("Wiki source was validated but publish is skipped");
    expect(workflow).toContain("bun run scripts/sync-github-wiki.ts --publish");
    expect(workflow).not.toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });
});
