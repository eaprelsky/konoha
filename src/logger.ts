/**
 * logger.ts — structured JSON logger for Konoha server.
 *
 * Outputs one JSON line per log entry to stdout (info/debug) or stderr (warn/error).
 * Log level controlled by LOG_LEVEL env var (default: "info").
 *
 * Usage:
 *   import { createLogger } from './logger';
 *   const log = createLogger('runtime:cases');
 *   log.info('case created', { case_id, process_id });
 *   log.error('advance failed', { case_id, error: e.message });
 */

import { config } from "./config";

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_NUM: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = config.logging.level as Level;
const minNum = LEVEL_NUM[minLevel] ?? 1;

export function createLogger(module: string) {
  function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_NUM[level] < minNum) return;
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      module,
      msg,
      ...extra,
    };
    const line = JSON.stringify(entry) + '\n';
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  return {
    debug: (msg: string, extra?: Record<string, unknown>) => log('debug', msg, extra),
    info:  (msg: string, extra?: Record<string, unknown>) => log('info',  msg, extra),
    warn:  (msg: string, extra?: Record<string, unknown>) => log('warn',  msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log('error', msg, extra),
  };
}

/**
 * Execute an async operation safely — logs errors instead of swallowing silently.
 * Use to replace `catch(() => {})` and `catch (_ => {})` patterns.
 */
export async function safeExec(fn: () => Promise<unknown>, context?: string): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    const fallback = createLogger("safe-exec");
    fallback.warn(context ?? "suppressed error", { error: e?.message ?? String(e) });
  }
}

/**
 * Error handler for fire-and-forget async operations.
 * Logs at debug level instead of silently swallowing.
 * Usage: `someAsyncOp().catch(silentCatch("operation context"))`
 */
export function silentCatch(context: string) {
  const log = createLogger("fire-and-forget");
  return (e: any) => { log.debug(context, { error: e?.message ?? String(e) }); };
}
