/**
 * visual.ts — Visual regression for konoha-testbench (closes #297)
 *
 * Baselines stored at: /opt/shared/testbench/baselines/{page_slug}/
 *   baseline_<ts>.png  — named snapshots
 *   current.png        — symlink → last approved baseline
 *   last_diff.png      — most recent diff output
 *
 * Comparison threshold: 1% of pixels different → FAIL
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync } from "fs";
import { join } from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export const BASELINES_DIR = process.env.TESTBENCH_BASELINES_DIR || "/opt/shared/testbench/baselines";
export const DIFF_THRESHOLD = parseFloat(process.env.TESTBENCH_DIFF_THRESHOLD || "0.01"); // 1%

export interface VisualResult {
  page: string;
  has_baseline: boolean;
  /** Fraction of differing pixels (0–1). Null if no baseline. */
  diff_ratio: number | null;
  /** Pass = diff_ratio < DIFF_THRESHOLD (or no baseline → auto-pass) */
  passed: boolean;
  /** Base64-encoded diff PNG, only when diff_ratio >= threshold */
  diff_base64?: string;
  baseline_ts?: string;
}

/** Slugify a page name / URL path for use as directory name */
export function slugify(page: string): string {
  return page.replace(/^https?:\/\/[^/]+/, "").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "root";
}

/** Get the baseline directory for a page slug */
export function baselineDir(slug: string): string {
  return join(BASELINES_DIR, slug);
}

/** Save screenshot as new baseline, update `current` symlink */
export function saveBaseline(slug: string, pngBuf: Buffer): string {
  const dir = baselineDir(slug);
  mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `baseline_${ts}.png`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, pngBuf);

  // Update current symlink
  const currentLink = join(dir, "current.png");
  if (existsSync(currentLink)) unlinkSync(currentLink);
  symlinkSync(filename, currentLink);

  return ts;
}

/** Check if a baseline exists for slug */
export function hasBaseline(slug: string): boolean {
  return existsSync(join(baselineDir(slug), "current.png"));
}

/** Get timestamp of current baseline */
export function baselineTimestamp(slug: string): string | null {
  const link = join(baselineDir(slug), "current.png");
  if (!existsSync(link)) return null;
  // read symlink target filename → extract timestamp
  const target = require("fs").readlinkSync(link) as string;
  const m = target.match(/baseline_(.+)\.png$/);
  return m ? m[1] : null;
}

/** Compare screenshot buffer against stored baseline */
export function compareWithBaseline(slug: string, currentBuf: Buffer): VisualResult {
  const dir = baselineDir(slug);
  const currentLink = join(dir, "current.png");

  if (!existsSync(currentLink)) {
    return { page: slug, has_baseline: false, diff_ratio: null, passed: true };
  }

  const baselineBuf = readFileSync(currentLink);

  let baselinePng: PNG, currentPng: PNG;
  try {
    baselinePng = PNG.sync.read(baselineBuf);
    currentPng = PNG.sync.read(currentBuf);
  } catch (e: any) {
    return { page: slug, has_baseline: true, diff_ratio: null, passed: false };
  }

  // If dimensions differ, treat as 100% diff
  if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
    return {
      page: slug,
      has_baseline: true,
      diff_ratio: 1,
      passed: false,
      baseline_ts: baselineTimestamp(slug) ?? undefined,
    };
  }

  const { width, height } = baselinePng;
  const diffPng = new PNG({ width, height });

  const numDiffPixels = pixelmatch(
    baselinePng.data,
    currentPng.data,
    diffPng.data,
    width,
    height,
    { threshold: 0.1, includeAA: false },
  );

  const totalPixels = width * height;
  const diff_ratio = numDiffPixels / totalPixels;
  const passed = diff_ratio < DIFF_THRESHOLD;

  const result: VisualResult = {
    page: slug,
    has_baseline: true,
    diff_ratio,
    passed,
    baseline_ts: baselineTimestamp(slug) ?? undefined,
  };

  if (!passed) {
    const diffBuf = PNG.sync.write(diffPng);
    // Save diff image to disk
    writeFileSync(join(dir, "last_diff.png"), diffBuf);
    result.diff_base64 = diffBuf.toString("base64");
  }

  return result;
}

/** List all pages that have baselines */
export function listBaselines(): { slug: string; has_current: boolean; baseline_ts: string | null }[] {
  if (!existsSync(BASELINES_DIR)) return [];
  return readdirSync(BASELINES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
      slug: d.name,
      has_current: existsSync(join(BASELINES_DIR, d.name, "current.png")),
      baseline_ts: baselineTimestamp(d.name),
    }));
}
