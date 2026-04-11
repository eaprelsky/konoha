/**
 * pool.ts — BrowserContext session pool for konoha-testbench.
 * Maintains N=3 isolated Playwright BrowserContexts on a single persistent Chromium instance.
 * Callers acquire a session, use it, then release it back to the pool.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export const POOL_SIZE = parseInt(process.env.TESTBENCH_POOL_SIZE || "3");
const ACQUIRE_TIMEOUT_MS = 30_000;

export interface Session {
  id: number;
  context: BrowserContext;
  page: Page;
  /** ISO timestamp of last acquire */
  acquiredAt: string;
  /** Accumulated console log for current session */
  consoleLogs: { level: string; text: string; ts: string }[];
  /** Accumulated network log */
  networkLog: { method: string; url: string; status?: number; ts: string }[];
}

let _browser: Browser | null = null;
const _pool: (Session | null)[] = new Array(POOL_SIZE).fill(null);
const _available: number[] = []; // indices of free slots
const _waiters: ((idx: number) => void)[] = [];

/** Initialize browser and warm-up session pool */
export async function initPool(): Promise<void> {
  _browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  for (let i = 0; i < POOL_SIZE; i++) {
    await _createSession(i);
    _available.push(i);
  }
  console.log(`[pool] Initialized ${POOL_SIZE} browser contexts`);
}

async function _createSession(idx: number): Promise<void> {
  if (!_browser) throw new Error("Browser not initialized");
  const context = await _browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "KonohaTestBench/1.0 (Playwright)",
  });
  const page = await context.newPage();

  // Inject Authorization header on all /api/* requests (#467 fix).
  // page.route() intercepts at Playwright level — more reliable than setExtraHTTPHeaders()
  // which doesn't consistently apply to browser-initiated fetch() calls after goto().
  const token = process.env.KONOHA_TOKEN || "";
  if (token) {
    await page.route("**/api/**", async (route) => {
      await route.continue({
        headers: { ...route.request().headers(), Authorization: `Bearer ${token}` },
      });
    });
  }

  const session: Session = {
    id: idx,
    context,
    page,
    acquiredAt: "",
    consoleLogs: [],
    networkLog: [],
  };

  // Capture console messages
  page.on("console", (msg) => {
    session.consoleLogs.push({
      level: msg.type(),
      text: msg.text(),
      ts: new Date().toISOString(),
    });
    // Keep last 200 entries only
    if (session.consoleLogs.length > 200) session.consoleLogs.shift();
  });

  // Capture network requests
  page.on("response", (resp) => {
    session.networkLog.push({
      method: resp.request().method(),
      url: resp.url(),
      status: resp.status(),
      ts: new Date().toISOString(),
    });
    if (session.networkLog.length > 200) session.networkLog.shift();
  });

  _pool[idx] = session;
}

/** Acquire a free session, waiting up to ACQUIRE_TIMEOUT_MS if all are busy */
export async function acquireSession(): Promise<Session> {
  if (_available.length > 0) {
    const idx = _available.shift()!;
    const session = _pool[idx]!;
    session.acquiredAt = new Date().toISOString();
    return session;
  }

  // Wait for a slot to free
  const idx = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = _waiters.indexOf(resolve);
      if (i >= 0) _waiters.splice(i, 1);
      reject(new Error(`No free TestBench session (pool size ${POOL_SIZE}) — try again after 30s`));
    }, ACQUIRE_TIMEOUT_MS);
    _waiters.push((i) => { clearTimeout(timer); resolve(i); });
  });

  const session = _pool[idx]!;
  session.acquiredAt = new Date().toISOString();
  return session;
}

/** Acquire a specific session by ID. Throws if the session is currently busy. */
export async function acquireSessionById(id: number): Promise<Session> {
  if (id < 0 || id >= POOL_SIZE) throw new Error(`Invalid session id: ${id} (pool size ${POOL_SIZE})`);
  const idx = _available.indexOf(id);
  if (idx === -1) throw new Error(`Session ${id} is busy`);
  _available.splice(idx, 1);
  const session = _pool[id]!;
  session.acquiredAt = new Date().toISOString();
  return session;
}

/** Release a session back to the pool (optionally reset it) */
export async function releaseSession(session: Session, reset = false): Promise<void> {
  if (reset) {
    try {
      await session.page.goto("about:blank");
      session.consoleLogs = [];
      session.networkLog = [];
    } catch {
      // If page is broken, recreate the context
      try { await session.context.close(); } catch {}
      await _createSession(session.id);
    }
  }
  session.acquiredAt = "";
  if (_waiters.length > 0) {
    const waiter = _waiters.shift()!;
    waiter(session.id);
  } else {
    // LIFO: push to front so the most recently used session (with loaded page state)
    // is reused by the next acquire, keeping navigate → snapshot patterns consistent.
    _available.unshift(session.id);
  }
}

/** Pool status for GET /testbench/status */
export function poolStatus(): { total: number; free: number; waiting: number; sessions: object[] } {
  return {
    total: POOL_SIZE,
    free: _available.length,
    waiting: _waiters.length,
    sessions: _pool.map((s, i) => ({
      id: i,
      free: _available.includes(i),
      acquired_at: s?.acquiredAt || null,
      url: s?.page.url() || null,
    })),
  };
}

export async function closePool(): Promise<void> {
  for (const session of _pool) {
    if (session) {
      try { await session.context.close(); } catch {}
    }
  }
  if (_browser) {
    try { await _browser.close(); } catch {}
  }
}
