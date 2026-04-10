/**
 * events/utils.ts — Pure utility functions and in-memory helpers for the event manager.
 */

import { parseBdDuration } from "../work-calendar";
import { createLogger } from "../logger";
import type { UiStatus, Subscription, TriggerDef, TimerTrigger, DelayAfterTrigger, ConditionTrigger } from "./types";
import { CronExpressionParser } from "cron-parser";

const log = createLogger("event-manager");

// ── ISO 8601 duration parser (subset: PT<n>S / PT<n>M / PT<n>H / P<n>D) ─────
// P{N}BD (business day durations) are NOT handled here — use resolveDelayMs() instead.

export function parseDurationMs(iso: string): number {
  const match = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) throw new Error(`Invalid ISO 8601 duration: "${iso}"`);
  const [, d, h, m, s] = match;
  return (
    (parseInt(d ?? "0") * 86400 +
     parseInt(h ?? "0") * 3600 +
     parseInt(m ?? "0") * 60 +
     parseFloat(s ?? "0")) * 1000
  );
}

/**
 * Resolve a delay duration to milliseconds.
 * Handles both standard ISO 8601 and P{N}BD (business day) durations.
 * For BD durations, subscribedAt is the reference date.
 */
export async function resolveDelayMs(duration: string, subscribedAt: string): Promise<number> {
  const { parseBdDuration, addBusinessDays } = await import("../work-calendar");
  const bd = parseBdDuration(duration);
  if (bd) {
    const fromDate = subscribedAt.slice(0, 10); // YYYY-MM-DD
    const targetDate = await addBusinessDays(fromDate, bd.businessDays);
    const targetMs = new Date(targetDate + "T09:00:00.000Z").getTime();
    const delayMs = targetMs - Date.now();
    if (delayMs <= 0) return 1000; // fire immediately if already past
    return delayMs;
  }
  return parseDurationMs(duration);
}

// ── Compute next fire time for timer triggers ─────────────────────────────────

export function computeNextFireAt(trigger: TriggerDef, subscribedAt?: string): string | undefined {
  if (trigger.kind === "timer") {
    const t = trigger as TimerTrigger;
    if (t.cron) {
      try {
        const interval = CronExpressionParser.parse(t.cron, { currentDate: new Date() });
        return interval.next().toDate().toISOString();
      } catch { return undefined; }
    }
  }
  if (trigger.kind === "delay_after") {
    const t = trigger as DelayAfterTrigger;
    if (t.duration && subscribedAt) {
      try {
        if (parseBdDuration(t.duration)) return undefined;
        const ms = parseDurationMs(t.duration);
        return new Date(new Date(subscribedAt).getTime() + ms).toISOString();
      } catch { return undefined; }
    }
  }
  return undefined;
}

// ── Compute UI status ─────────────────────────────────────────────────────────

export function computeUiStatus(sub: Subscription): UiStatus {
  if (sub.error) return "error";
  if (sub.status === "cancelled" && sub.last_fired_at) return "fired";
  if (sub.mode === "manual") return "manual_fallback";
  return "waiting";
}

// ── Summary builder ───────────────────────────────────────────────────────────

export function buildSummary(
  subs: Array<Subscription & { ui_status: UiStatus }>,
  todayStart: Date,
  todayEnd: Date,
): Record<string, number> {
  const waiting = subs.filter(s => s.ui_status === "waiting").length;
  const errors = subs.filter(s => s.ui_status === "error").length;
  const manual_fallback = subs.filter(s => s.ui_status === "manual_fallback").length;
  const fired_today = subs.filter(s =>
    s.last_fired_at &&
    new Date(s.last_fired_at) >= todayStart &&
    new Date(s.last_fired_at) <= todayEnd,
  ).length;
  return {
    total: subs.length,
    waiting,
    fired_today,
    errors,
    manual_fallback,
  };
}

// ── Condition evaluation ──────────────────────────────────────────────────────

export function evalCondition(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case ">":  return value > threshold;
    case "<":  return value < threshold;
    case ">=": return value >= threshold;
    case "<=": return value <= threshold;
    case "==": return value === threshold;
    case "!=": return value !== threshold;
    default:   return false;
  }
}

// ── Retry with exponential backoff ───────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = MAX_RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: Error = new Error("unknown");
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
      log.warn(`[event-manager] ${label} attempt ${attempt + 1}/${maxAttempts} failed: ${e.message}. Retrying in ${delayMs}ms…`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// ── Adapter stats (in-memory) ─────────────────────────────────────────────────

export interface AdapterStats {
  name: string;
  last_success_at?: string;
  last_error_at?: string;
  last_error?: string;
  error_count: number;
  active_listeners: number;
}

export const adapterStats = new Map<string, AdapterStats>();

export function getAdapterStats(name: string): AdapterStats {
  if (!adapterStats.has(name)) {
    adapterStats.set(name, { name, error_count: 0, active_listeners: 0 });
  }
  return adapterStats.get(name)!;
}

export function recordAdapterSuccess(name: string): void {
  const s = getAdapterStats(name);
  s.last_success_at = new Date().toISOString();
}

export function recordAdapterError(name: string, msg: string): void {
  const s = getAdapterStats(name);
  s.last_error_at = new Date().toISOString();
  s.last_error = msg;
  s.error_count++;
}

// ── Token bucket rate limiter (per adapter, for condition polling) ────────────

const DEFAULT_MAX_RPS = 1;

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillMs: number; // ms per token

  constructor(maxRps: number) {
    this.maxTokens = Math.max(1, maxRps);
    this.refillMs = 1000 / maxRps;
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(source: string): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillMs);
    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill = Date.now();
    }
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    const waitMs = this.refillMs - (Date.now() - this.lastRefill);
    const wait = Math.max(1, Math.round(waitMs));
    log.info(`[event-manager] rate-limit throttle source=${source} wait=${wait}ms`);
    await new Promise<void>(resolve => setTimeout(resolve, wait));
    this.tokens = 0;
  }
}

export const adapterRateLimiters = new Map<string, TokenBucket>();

export function getAdapterRateLimiter(source: string): TokenBucket {
  if (!adapterRateLimiters.has(source)) {
    const envKey = `ADAPTER_MAX_RPS_${source.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const maxRps = parseFloat(process.env[envKey] || '') || DEFAULT_MAX_RPS;
    adapterRateLimiters.set(source, new TokenBucket(maxRps));
  }
  return adapterRateLimiters.get(source)!;
}

export { DEFAULT_MAX_RPS };
