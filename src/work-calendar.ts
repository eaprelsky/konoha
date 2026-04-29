/**
 * work-calendar.ts — WorkCalendar service (Extension A).
 *
 * Manages production calendar for business day calculations.
 * - Russian production calendar 2026 pre-populated
 * - Supports P{N}BD ISO-8601-like duration strings (e.g. P3BD = 3 business days)
 * - Persists custom overrides (extra holidays, working day shifts) in Redis
 *
 * Endpoints:
 *   GET /api/work-calendar/info            — today's status + nearest working/non-working days
 *   GET /api/work-calendar/month           — day-by-day working status for a month (?year=&month=)
 *   POST /api/work-calendar/override       — add custom holiday or working day override (admin)
 *   DELETE /api/work-calendar/override/:date — remove override (admin)
 */

import { redis } from "./redis";
import type { Hono, MiddlewareHandler } from "hono";
import type { HonoEnv } from "./types";
import { requireAdmin } from "./middleware/auth";

// ── Types ────────────────────────────────────────────────────────────────────

export type DayStatus = "working" | "holiday" | "weekend";

export interface DayInfo {
  date: string;       // YYYY-MM-DD
  status: DayStatus;
  name?: string;      // holiday name if applicable
}

// ── Russian production calendar 2026 ─────────────────────────────────────────
// Source: постановление Правительства РФ о переносах рабочих дней
// Standard weekends (Sat/Sun) are handled automatically.
// This list contains only official holidays and transfer days.

const RUSSIA_2026_HOLIDAYS: Record<string, { status: DayStatus; name: string }> = {
  // New Year holidays (1–8 January)
  "2026-01-01": { status: "holiday", name: "Новогодние каникулы" },
  "2026-01-02": { status: "holiday", name: "Новогодние каникулы" },
  "2026-01-05": { status: "holiday", name: "Новогодние каникулы" },
  "2026-01-06": { status: "holiday", name: "Новогодние каникулы" },
  "2026-01-07": { status: "holiday", name: "Рождество Христово" },
  "2026-01-08": { status: "holiday", name: "Новогодние каникулы" },

  // Defender of the Fatherland Day — 23 February (Monday)
  "2026-02-23": { status: "holiday", name: "День защитника Отечества" },

  // International Women's Day — 8 March (Sunday), transfer to 9 March (Monday)
  "2026-03-09": { status: "holiday", name: "Международный женский день (перенос)" },

  // Spring and Labor Day — 1 May (Friday)
  "2026-05-01": { status: "holiday", name: "Праздник Весны и Труда" },

  // Victory Day — 9 May (Saturday), transfer to 11 May (Monday)
  "2026-05-11": { status: "holiday", name: "День Победы (перенос)" },

  // Russia Day — 12 June (Friday)
  "2026-06-12": { status: "holiday", name: "День России" },

  // National Unity Day — 4 November (Wednesday)
  "2026-11-04": { status: "holiday", name: "День народного единства" },
};

// ── Redis key ────────────────────────────────────────────────────────────────

const OVERRIDES_KEY = "work-calendar:overrides";

// ── Core calendar logic ───────────────────────────────────────────────────────

async function loadOverrides(): Promise<Record<string, { status: DayStatus; name?: string }>> {
  const raw = await redis.hgetall(OVERRIDES_KEY).catch(() => ({}));
  const result: Record<string, { status: DayStatus; name?: string }> = {};
  for (const [date, val] of Object.entries(raw)) {
    try { result[date] = JSON.parse(val); } catch { /* skip */ }
  }
  return result;
}

function isWeekend(date: Date): boolean {
  const d = date.getUTCDay();
  return d === 0 || d === 6;
}

function toDateStr(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDateStr(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export async function getDayStatus(
  dateStr: string,
  overrides?: Record<string, { status: DayStatus; name?: string }>,
): Promise<DayInfo> {
  const ov = overrides ?? await loadOverrides();

  // Custom override takes priority
  if (ov[dateStr]) {
    return { date: dateStr, status: ov[dateStr].status, name: ov[dateStr].name };
  }

  // Official 2026 holiday
  if (RUSSIA_2026_HOLIDAYS[dateStr]) {
    const h = RUSSIA_2026_HOLIDAYS[dateStr];
    return { date: dateStr, status: h.status, name: h.name };
  }

  // Standard weekend
  const d = parseDateStr(dateStr);
  if (isWeekend(d)) {
    return { date: dateStr, status: "weekend" };
  }

  return { date: dateStr, status: "working" };
}

export async function isWorkingDay(dateStr: string): Promise<boolean> {
  const info = await getDayStatus(dateStr);
  return info.status === "working";
}

/**
 * Returns the next working day at or after the given date.
 * If fromDate itself is a working day, returns it.
 */
export async function nextWorkingDay(fromDateStr: string): Promise<string> {
  const overrides = await loadOverrides();
  let d = parseDateStr(fromDateStr);
  for (let i = 0; i < 14; i++) {
    const s = toDateStr(d);
    const info = await getDayStatus(s, overrides);
    if (info.status === "working") return s;
    d = new Date(d.getTime() + 86_400_000);
  }
  throw new Error("Could not find next working day within 14 days");
}

/**
 * Add N business days to the given date.
 * Does not count the start date itself.
 */
export async function addBusinessDays(fromDateStr: string, n: number): Promise<string> {
  const overrides = await loadOverrides();
  let d = parseDateStr(fromDateStr);
  let added = 0;
  let safety = 0;
  while (added < n && safety < 60) {
    d = new Date(d.getTime() + 86_400_000);
    safety++;
    const s = toDateStr(d);
    const info = await getDayStatus(s, overrides);
    if (info.status === "working") added++;
  }
  return toDateStr(d);
}

/**
 * Get day-by-day info for a calendar month.
 */
export async function getMonthCalendar(year: number, month: number): Promise<DayInfo[]> {
  const overrides = await loadOverrides();
  const days: DayInfo[] = [];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    days.push(await getDayStatus(dateStr, overrides));
  }
  return days;
}

// ── P{N}BD duration parsing ───────────────────────────────────────────────────

/**
 * Parse a P{N}BD duration string.
 * P3BD = 3 business days.
 * Returns { businessDays: N } or null if not a BD duration.
 */
export function parseBdDuration(duration: string): { businessDays: number } | null {
  const m = /^P(\d+)BD$/i.exec(duration.trim());
  if (!m) return null;
  return { businessDays: parseInt(m[1], 10) };
}

/**
 * Compute the absolute timestamp for a delay_after trigger with P{N}BD duration.
 * fromDate is the trigger subscription time.
 */
export async function resolveBdDelay(fromDateStr: string, duration: string): Promise<Date | null> {
  const bd = parseBdDuration(duration);
  if (!bd) return null;
  const resultDate = await addBusinessDays(fromDateStr, bd.businessDays);
  return parseDateStr(resultDate);
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerWorkCalendarRoutes(
  app: Hono<HonoEnv>,
  requireAuth: MiddlewareHandler<HonoEnv>,
): void {

  // GET /api/work-calendar/info — today's working day status + next dates
  app.get("/work-calendar/info", requireAuth, async (c) => {
    const today = toDateStr(new Date());
    const overrides = await loadOverrides();

    const todayInfo = await getDayStatus(today, overrides);

    // Find next working day (from tomorrow)
    let nextWorking: string | null = null;
    {
      let d = parseDateStr(today);
      d = new Date(d.getTime() + 86_400_000);
      for (let i = 0; i < 14 && !nextWorking; i++) {
        const s = toDateStr(d);
        const info = await getDayStatus(s, overrides);
        if (info.status === "working") nextWorking = s;
        d = new Date(d.getTime() + 86_400_000);
      }
    }

    // Find next non-working day (from tomorrow)
    let nextNonWorking: string | null = null;
    {
      let d = parseDateStr(today);
      d = new Date(d.getTime() + 86_400_000);
      for (let i = 0; i < 14 && !nextNonWorking; i++) {
        const s = toDateStr(d);
        const info = await getDayStatus(s, overrides);
        if (info.status !== "working") nextNonWorking = s;
        d = new Date(d.getTime() + 86_400_000);
      }
    }

    return c.json({
      calendar_id: "default",
      today: todayInfo,
      next_working_day: nextWorking,
      next_non_working_day: nextNonWorking,
      year: new Date().getUTCFullYear(),
    });
  });

  // GET /api/work-calendar/month?year=2026&month=4
  app.get("/work-calendar/month", requireAuth, async (c) => {
    const year = parseInt(c.req.query("year") || String(new Date().getUTCFullYear()), 10);
    const month = parseInt(c.req.query("month") || String(new Date().getUTCMonth() + 1), 10);
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return c.json({ error: "year and month (1-12) required" }, 400);
    }
    const days = await getMonthCalendar(year, month);
    return c.json({ year, month, days });
  });

  // POST /api/work-calendar/override — add custom override (admin only)
  app.post("/work-calendar/override", requireAdmin, async (c) => {
    const body = await c.req.json<{ date: string; status: DayStatus; name?: string }>().catch(() => null);
    if (!body?.date || !body.status) return c.json({ error: "date and status required" }, 400);
    if (!["working", "holiday", "weekend"].includes(body.status)) {
      return c.json({ error: "status must be working, holiday, or weekend" }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    }
    await redis.hset(OVERRIDES_KEY, body.date, JSON.stringify({ status: body.status, name: body.name }));
    return c.json({ ok: true, date: body.date, status: body.status });
  });

  // DELETE /api/work-calendar/override/:date — remove custom override (admin only)
  app.delete("/work-calendar/override/:date", requireAdmin, async (c) => {
    const date = c.req.param("date")!;
    const deleted = await redis.hdel(OVERRIDES_KEY, date);
    return c.json({ ok: true, deleted });
  });

  // GET /api/work-calendar/overrides — list all custom overrides
  app.get("/work-calendar/overrides", requireAuth, async (c) => {
    const overrides = await loadOverrides();
    return c.json(overrides);
  });
}
