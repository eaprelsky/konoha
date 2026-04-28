/**
 * konoha-testbench — Persistent Chromium service with HTTP API for agent-driven GUI testing.
 * Agents call simple actions ("navigate", "click", "type") and receive snapshots
 * (screenshot + a11y tree + console log + network log + bounding boxes).
 *
 * Issue #292.
 */

import { Hono } from "hono";
import { initPool, acquireSession, acquireSessionById, releaseSession, poolStatus, closePool, POOL_SIZE, type Session } from "./pool";
import {
  slugify, saveBaseline, hasBaseline, compareWithBaseline, listBaselines,
  DIFF_THRESHOLD,
} from "./visual";

const PORT = parseInt(process.env.TESTBENCH_PORT || "3201");
const TOKEN = process.env.KONOHA_TOKEN || "";

// localStorage key used by the Konoha dashboard to check login state (#463).
// Must stay in sync with frontend/src/entries/app.tsx and frontend/src/components/Layout.tsx.
const DASH_AUTH_KEY = "konoha_dash_auth";

let shuttingDown = false;

const app = new Hono();

// ── Auth middleware ───────────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  if (shuttingDown) return c.json({ error: "TestBench is shutting down" }, 503);
  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!TOKEN || token !== TOKEN) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ── GET /testbench/status ─────────────────────────────────────────────────────

app.get("/testbench/status", (c) => {
  return c.json({ ok: true, ...poolStatus() });
});

// ── POST /testbench/login ─────────────────────────────────────────────────────
// Perform form-based login in one or all sessions (fixes #327).
// Each BrowserContext has its own localStorage, so login must be done per-session.
// Body: { url, username, password, username_selector?, password_selector?, submit_selector?, session_id? }
// session_id: number | "all" (default: "all")

app.post("/testbench/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    url,
    username,
    password,
    username_selector = "#u",
    password_selector = "#p",
    submit_selector = "button[type=submit]",
    session_id = "all",
  } = body as {
    url: string;
    username: string;
    password: string;
    username_selector?: string;
    password_selector?: string;
    submit_selector?: string;
    session_id?: number | "all";
  };

  if (!url) return c.json({ error: "url required" }, 400);
  if (!username || !password) return c.json({ error: "username and password required" }, 400);

  const sessionIds: number[] = session_id === "all"
    ? Array.from({ length: POOL_SIZE }, (_, i) => i)
    : [Number(session_id)];

  const results: { session_id: number; ok: boolean; url?: string; error?: string }[] = [];

  for (const sid of sessionIds) {
    let session: Session | null = null;
    try {
      session = await acquireSessionById(sid);
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await session.page.fill(username_selector, username, { timeout: 5_000 });
      await session.page.fill(password_selector, password, { timeout: 5_000 });
      await session.page.click(submit_selector, { timeout: 5_000 });
      await session.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
      await session.page.evaluate(() => { localStorage.setItem(DASH_AUTH_KEY, "1"); }).catch(() => {});
      results.push({ session_id: sid, ok: true, url: session.page.url() });
    } catch (e: any) {
      results.push({ session_id: sid, ok: false, error: e.message });
    } finally {
      if (session) releaseSession(session).catch(() => {});
    }
  }

  const allOk = results.every(r => r.ok);
  return c.json({ ok: allOk, results }, allOk ? 200 : 207);
});

// ── POST /testbench/navigate ──────────────────────────────────────────────────

app.post("/testbench/navigate", async (c) => {
  const { url, session_id } = await c.req.json().catch(() => ({}));
  if (!url) return c.json({ error: "url required" }, 400);

  const session = await (session_id !== undefined ? acquireSessionById(Number(session_id)) : acquireSession()).catch((e) => { throw e; });
  try {
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // Inject dashboard auth token so Playwright sessions bypass the login wall (#463).
    // localStorage is per-origin; this is a no-op on pages that don't use this key.
    await session.page.evaluate(() => {
      localStorage.setItem(DASH_AUTH_KEY, "1");
    }).catch(() => {});
    const finalUrl = session.page.url();
    const title = await session.page.title().catch(() => "");
    return c.json({ ok: true, session_id: session.id, url: finalUrl, title });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  } finally {
    releaseSession(session).catch(() => {});
  }
});

// ── POST /testbench/action ────────────────────────────────────────────────────

type ActionType = "click" | "type" | "scroll" | "hover" | "press" | "clear";

app.post("/testbench/action", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { type, selector, text, amount, key, session_id } = body as {
    type: ActionType;
    selector?: string;
    text?: string;
    amount?: number;
    key?: string;
    session_id?: number;
  };

  if (!type) return c.json({ error: "type required" }, 400);

  const session = await (session_id !== undefined ? acquireSessionById(Number(session_id)) : acquireSession()).catch((e) => { throw e; });
  try {
    const page = session.page;

    switch (type) {
      case "click":
        if (!selector) return c.json({ error: "selector required for click" }, 400);
        await page.click(selector, { timeout: 10_000 });
        break;
      case "type":
        if (!selector || text === undefined) return c.json({ error: "selector and text required for type" }, 400);
        await page.fill(selector, text, { timeout: 10_000 });
        break;
      case "scroll":
        if (selector) {
          await page.locator(selector).scrollIntoViewIfNeeded({ timeout: 10_000 });
        } else {
          await page.evaluate((px: number) => window.scrollBy(0, px), amount ?? 300);
        }
        break;
      case "hover":
        if (!selector) return c.json({ error: "selector required for hover" }, 400);
        await page.hover(selector, { timeout: 10_000 });
        break;
      case "press":
        if (!selector || !key) return c.json({ error: "selector and key required for press" }, 400);
        await page.press(selector, key, { timeout: 10_000 });
        break;
      case "clear":
        if (!selector) return c.json({ error: "selector required for clear" }, 400);
        await page.locator(selector).clear({ timeout: 10_000 });
        break;
      default:
        return c.json({ error: `unknown action type: ${type}` }, 400);
    }

    return c.json({ ok: true, session_id: session.id, url: page.url() });
  } catch (e: any) {
    return c.json({ error: e.message, session_id: session.id }, 500);
  } finally {
    releaseSession(session).catch(() => {});
  }
});

// ── GET /testbench/snapshot ───────────────────────────────────────────────────

app.get("/testbench/snapshot", async (c) => {
  const session = await acquireSession().catch((e) => { throw e; });
  try {
    return c.json(await buildSnapshot(session));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  } finally {
    releaseSession(session).catch(() => {});
  }
});

async function buildSnapshot(session: Session) {
  const page = session.page;

  // Screenshot (base64 PNG)
  const screenshotBuf = await page.screenshot({ type: "png", fullPage: false });
  const screenshot_base64 = screenshotBuf.toString("base64");

  // Accessibility tree (ARIA snapshot string — page.accessibility was removed in Playwright 1.45)
  const accessibility_tree = await page.locator("body").ariaSnapshot().catch(() => null);

  // Bounding boxes for interactive elements
  const bounding_boxes = await page.evaluate(() => {
    const selectors = ["button", "a", "input", "select", "textarea", "[role=button]", "[role=link]"];
    const results: { tag: string; text: string; selector: string; bbox: object }[] = [];
    for (const sel of selectors) {
      const els = document.querySelectorAll<HTMLElement>(sel);
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        results.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 80),
          selector: el.id ? `#${el.id}` : sel,
          bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        });
        if (results.length >= 100) break; // cap at 100
      }
    }
    return results;
  }).catch(() => [] as object[]);

  // Compute overlaps between bounding boxes
  const computed_overlaps = computeOverlaps(bounding_boxes as { bbox: { x: number; y: number; w: number; h: number }; tag: string; text: string }[]);

  const snapshot = {
    session_id: session.id,
    url: page.url(),
    title: await page.title().catch(() => ""),
    screenshot_base64,
    accessibility_tree,
    bounding_boxes,
    computed_overlaps,
    console_log: [...session.consoleLogs],
    network_log: session.networkLog.slice(-50), // last 50 requests
  };

  // Clear logs after snapshot (they've been consumed)
  session.consoleLogs = [];

  return snapshot;
}

function computeOverlaps(
  boxes: { bbox: { x: number; y: number; w: number; h: number }; tag: string; text: string }[]
): { a: number; b: number; overlap_px: number }[] {
  const overlaps: { a: number; b: number; overlap_px: number }[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].bbox, b = boxes[j].bbox;
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const area = ox * oy;
      if (area > 0) overlaps.push({ a: i, b: j, overlap_px: area });
    }
  }
  return overlaps;
}

// ── POST /testbench/resize ────────────────────────────────────────────────────

app.post("/testbench/resize", async (c) => {
  const { width, height } = await c.req.json().catch(() => ({}));
  if (!width || !height) return c.json({ error: "width and height required" }, 400);
  if (width < 320 || width > 3840 || height < 240 || height > 2160) {
    return c.json({ error: "width must be 320-3840, height must be 240-2160" }, 400);
  }

  const session = await acquireSession().catch((e) => { throw e; });
  try {
    await session.page.setViewportSize({ width, height });
    return c.json({ ok: true, session_id: session.id, width, height });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  } finally {
    releaseSession(session).catch(() => {});
  }
});

// ── POST /testbench/reset ─────────────────────────────────────────────────────

app.post("/testbench/reset", async (c) => {
  const session = await acquireSession().catch((e) => { throw e; });
  try {
    await releaseSession(session, true); // reset=true clears logs + navigates to about:blank
    return c.json({ ok: true, session_id: session.id });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
  // Note: no finally releaseSession — already released with reset=true
});

// ── GET /testbench/baselines ──────────────────────────────────────────────────
// List all pages that have saved baselines.

app.get("/testbench/baselines", (c) => {
  return c.json({ ok: true, threshold: DIFF_THRESHOLD, baselines: listBaselines() });
});

// ── POST /testbench/baseline ──────────────────────────────────────────────────
// Navigate to url, take a screenshot, save as new baseline.
// Body: { url: string, page?: string }
// `page` is a human-readable slug; defaults to url path.

app.post("/testbench/baseline", async (c) => {
  const { url, page } = await c.req.json().catch(() => ({}));
  if (!url) return c.json({ error: "url required" }, 400);
  const slug = slugify(page || url);

  const session = await acquireSession().catch((e) => { throw e; });
  try {
    await session.page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const buf = await session.page.screenshot({ type: "png", fullPage: true });
    const ts = saveBaseline(slug, buf as Buffer);
    return c.json({ ok: true, page: slug, baseline_ts: ts, screenshot_bytes: buf.length });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  } finally {
    releaseSession(session).catch(() => {});
  }
});

// ── POST /testbench/update-baseline ──────────────────────────────────────────
// Update baselines for a list of pages. Intended for Shino after baseline-update GH issue.
// Body: { pages: Array<{ url: string, page?: string }> }

app.post("/testbench/update-baseline", async (c) => {
  const { pages } = await c.req.json().catch(() => ({}));
  if (!Array.isArray(pages) || pages.length === 0) {
    return c.json({ error: "pages array required" }, 400);
  }

  const results: { page: string; ok: boolean; baseline_ts?: string; error?: string }[] = [];

  for (const item of pages) {
    const { url, page } = item as { url: string; page?: string };
    if (!url) { results.push({ page: page || "?", ok: false, error: "url missing" }); continue; }
    const slug = slugify(page || url);

    const session = await acquireSession().catch((e) => ({ error: e.message })) as any;
    if (session.error) { results.push({ page: slug, ok: false, error: session.error }); continue; }

    try {
      await (session as Session).page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      const buf = await (session as Session).page.screenshot({ type: "png", fullPage: true });
      const ts = saveBaseline(slug, buf as Buffer);
      results.push({ page: slug, ok: true, baseline_ts: ts });
    } catch (e: any) {
      results.push({ page: slug, ok: false, error: e.message });
    } finally {
      releaseSession(session as Session).catch(() => {});
    }
  }

  const allOk = results.every(r => r.ok);
  return c.json({ ok: allOk, results }, allOk ? 200 : 207);
});

// ── POST /testbench/visual-regression ────────────────────────────────────────
// Navigate to each page, compare screenshot with baseline.
// Body: { pages: Array<{ url: string, page?: string }>, save_baseline_if_missing?: boolean }
// Returns per-page diff results + overall pass/fail.

app.post("/testbench/visual-regression", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { pages, save_baseline_if_missing = true } = body as {
    pages: Array<{ url: string; page?: string }>;
    save_baseline_if_missing?: boolean;
  };

  if (!Array.isArray(pages) || pages.length === 0) {
    return c.json({ error: "pages array required" }, 400);
  }

  const results = [];
  let newBaselines = 0;

  for (const item of pages) {
    const { url, page } = item as { url: string; page?: string };
    if (!url) { results.push({ page: page || "?", error: "url missing" }); continue; }
    const slug = slugify(page || url);

    const session = await acquireSession().catch((e) => ({ error: e.message })) as any;
    if (session.error) { results.push({ page: slug, error: session.error }); continue; }

    try {
      await (session as Session).page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      const buf = await (session as Session).page.screenshot({ type: "png", fullPage: true });

      if (!hasBaseline(slug)) {
        if (save_baseline_if_missing) {
          const ts = saveBaseline(slug, buf as Buffer);
          results.push({ page: slug, has_baseline: false, passed: true, note: "baseline created", baseline_ts: ts });
          newBaselines++;
        } else {
          results.push({ page: slug, has_baseline: false, passed: false, note: "no baseline — run with save_baseline_if_missing:true first" });
        }
      } else {
        const vr = compareWithBaseline(slug, buf as Buffer);
        results.push(vr);
      }
    } catch (e: any) {
      results.push({ page: slug, passed: false, error: e.message });
    } finally {
      releaseSession(session as Session).catch(() => {});
    }
  }

  const passed = results.every((r: any) => r.passed !== false && !r.error);
  const failed = results.filter((r: any) => r.passed === false || r.error);

  return c.json({
    ok: passed,
    passed,
    total: results.length,
    new_baselines: newBaselines,
    failed_count: failed.length,
    threshold: DIFF_THRESHOLD,
    results,
  }, passed ? 200 : 200); // always 200 — caller checks `passed`
});

// ── POST /testbench/run-suite ─────────────────────────────────────────────────
// Full Self-Writing Loop cycle:
//   1. Run visual regression for all pages
//   2. If all pass + issue_id given → call POST /deploy on Konoha (auto_deploy check)
//   3. If any fail → POST result to Konoha bus (kakashi:fix) with diff details
//
// Body: {
//   pages: Array<{ url: string, page?: string }>,
//   issue_id?: number,          // GitHub issue to close on success
//   notify_agent?: string,      // Konoha agent ID to notify on failure (default: kakashi)
//   konoha_url?: string,        // Konoha base URL (default: http://127.0.0.1:3100)
//   konoha_token?: string,      // Konoha auth token
// }

app.post("/testbench/run-suite", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const {
    pages,
    issue_id,
    notify_agent = "kakashi",
    konoha_url = process.env.KONOHA_URL || "http://127.0.0.1:3100",
    konoha_token = TOKEN,
  } = body as {
    pages: Array<{ url: string; page?: string }>;
    issue_id?: number;
    notify_agent?: string;
    konoha_url?: string;
    konoha_token?: string;
  };

  if (!Array.isArray(pages) || pages.length === 0) {
    return c.json({ error: "pages array required" }, 400);
  }

  // 1. Run visual regression
  const vrResp = await (async () => {
    const mockReq = new Request(`${konoha_url}/testbench/visual-regression`, {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${TOKEN}` },
      body: JSON.stringify({ pages, save_baseline_if_missing: true }),
    });
    // call internal handler directly via a self-fetch
    return fetch(`http://127.0.0.1:${PORT}/testbench/visual-regression`, {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${TOKEN}` },
      body: JSON.stringify({ pages, save_baseline_if_missing: true }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  })();

  const suiteResult: Record<string, unknown> = {
    ran_at: new Date().toISOString(),
    visual_regression: vrResp,
    issue_id: issue_id ?? null,
  };

  const passed: boolean = (vrResp as any).passed === true;

  if (passed) {
    // 2. Trigger deploy
    const deployResp = await fetch(`${konoha_url}/api/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${konoha_token}`,
      },
      body: JSON.stringify({ commit_sha: null }),
    }).then(r => r.json()).catch(e => ({ status: "error", error: e.message }));

    suiteResult.deploy = deployResp;

    // 3. Notify Konoha bus — success
    await fetch(`${konoha_url}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${konoha_token}` },
      body: JSON.stringify({
        from: "hinata",
        to: "naruto",
        type: "result",
        text: `TestBench suite PASS. ${(vrResp as any).total ?? 0} pages checked. Deploy: ${(deployResp as any).status ?? "?"}${issue_id ? `. Closes #${issue_id}` : ""}.`,
      }),
    }).catch(() => {});
  } else {
    // 3. Notify on failure — send to notify_agent with diff details
    const failed = ((vrResp as any).results ?? []).filter((r: any) => r.passed === false || r.error);
    const summary = failed.slice(0, 5).map((r: any) =>
      `• ${r.page}: ${r.error || `diff ${r.diff_ratio != null ? (r.diff_ratio * 100).toFixed(2) + "%" : "?"}`}`
    ).join("\n");

    await fetch(`${konoha_url}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${konoha_token}` },
      body: JSON.stringify({
        from: "hinata",
        to: notify_agent,
        type: "task",
        text: `TestBench suite FAIL (${failed.length}/${(vrResp as any).total ?? 0} pages)${issue_id ? ` for #${issue_id}` : ""}:\n${summary}\n\nFix and re-run suite.`,
      }),
    }).catch(() => {});

    suiteResult.failed_pages = failed;
  }

  return c.json({ ok: passed, ...suiteResult });
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.onError((err, c) => {
  const msg = err.message || String(err);
  if (msg.includes("No free TestBench session")) return c.json({ error: msg }, 503);
  console.error("[testbench] unhandled error:", msg);
  return c.json({ error: msg }, 500);
});

// ── Startup ───────────────────────────────────────────────────────────────────

await initPool();
console.log(`[testbench] Listening on port ${PORT}`);

async function shutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[testbench] ${signal} received, closing Playwright pool`);

  const forceExit = setTimeout(() => {
    console.error("[testbench] graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  forceExit.unref?.();

  try {
    await closePool();
    clearTimeout(forceExit);
    console.log("[testbench] shutdown complete");
    process.exit(0);
  } catch (e) {
    clearTimeout(forceExit);
    console.error("[testbench] shutdown failed:", e);
    process.exit(1);
  }
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 0,
};
