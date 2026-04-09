/**
 * konoha-testbench — Persistent Chromium service with HTTP API for agent-driven GUI testing.
 * Agents call simple actions ("navigate", "click", "type") and receive snapshots
 * (screenshot + a11y tree + console log + network log + bounding boxes).
 *
 * Issue #292.
 */

import { Hono } from "hono";
import { initPool, acquireSession, releaseSession, poolStatus, type Session } from "./pool";

const PORT = parseInt(process.env.TESTBENCH_PORT || "3201");
const TOKEN = process.env.KONOHA_TOKEN || "";

const app = new Hono();

// ── Auth middleware ───────────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!TOKEN || token !== TOKEN) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

// ── GET /testbench/status ─────────────────────────────────────────────────────

app.get("/testbench/status", (c) => {
  return c.json({ ok: true, ...poolStatus() });
});

// ── POST /testbench/navigate ──────────────────────────────────────────────────

app.post("/testbench/navigate", async (c) => {
  const { url, session_id } = await c.req.json().catch(() => ({}));
  if (!url) return c.json({ error: "url required" }, 400);

  const session = await acquireSession().catch((e) => { throw e; });
  try {
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
  const { type, selector, text, amount, key } = body as {
    type: ActionType;
    selector?: string;
    text?: string;
    amount?: number;
    key?: string;
  };

  if (!type) return c.json({ error: "type required" }, 400);

  const session = await acquireSession().catch((e) => { throw e; });
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

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 0,
};
