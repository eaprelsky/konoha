/**
 * Shared types, constants, helpers and styles for EventMonitor.
 * Extracted from EventMonitor.tsx (issue #448).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type UiStatus = 'waiting' | 'fired' | 'error' | 'manual_fallback';
export type Tab = 'timeline' | 'by-process' | 'by-source';

export interface Subscription {
  id: string;
  event_id: string;
  event_label?: string;
  process_id: string;
  process_name?: string;
  instance_id: string;
  trigger: Record<string, any>;
  status: 'active' | 'cancelled';
  mode: 'auto' | 'manual';
  ui_status: UiStatus;
  subscribed_at: string;
  next_fire_at?: string;
  last_fired_at?: string;
  fire_count?: number;
  last_poll_at?: string;
  last_poll_result?: unknown;
  error?: string;
}

export interface Summary {
  total: number;
  waiting: number;
  fired_today: number;
  errors: number;
  manual_fallback: number;
}

export interface AdapterStatus {
  name: string;
  status: 'available' | 'degraded' | 'unavailable';
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  error_count: number;
  active_listeners: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const TRIGGER_ICONS: Record<string, string> = {
  timer: '⏰',
  delay_after: '⏳',
  message: '📨',
  condition: '🔍',
  manual: '✋',
  system: '🔗',
};

export const STATUS_LABELS: Record<UiStatus, string> = {
  waiting: 'eventMonitor.waiting',
  fired: 'eventMonitor.statusFired',
  error: 'eventMonitor.errors',
  manual_fallback: 'eventMonitor.statusManualFallback',
};

export const STATUS_DOTS: Record<UiStatus, string> = {
  waiting: '◐',
  fired: '●',
  error: '✕',
  manual_fallback: '⚡',
};

export const SOURCE_ICONS: Record<string, string> = {
  bitrix: '📋',
  telegram: '💬',
  tracker: '📌',
  konoha: '🔗',
  timer: '⏰',
  manual: '✋',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

export function triggerIcon(trigger: Record<string, any>): string {
  return TRIGGER_ICONS[trigger.kind] ?? '⚙️';
}

export function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDateShort(iso?: string, todayLabel = 'Today'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const itemDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (itemDay.getTime() === today.getTime()) {
    return todayLabel + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function getSubSource(trigger: Record<string, any>): string {
  return trigger.source ?? trigger.data_source ?? trigger.kind ?? 'unknown';
}

// ── Styles ─────────────────────────────────────────────────────────────────────

export const eventMonitorStyles = `
  .em-body { padding: 20px; }
  .em-container { max-width: 1400px; margin: 0 auto; }

  /* Summary bar */
  .em-summary { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .em-counter { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 16px; font-size: 13px; min-width: 120px; }
  .em-counter .val { font-size: 22px; font-weight: 700; line-height: 1.2; }
  .em-counter .lbl { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .em-counter.ok .val { color: #16a34a; }
  .em-counter.warn .val { color: #d97706; }
  .em-counter.err .val { color: #dc2626; }
  .em-counter.info .val { color: #2563eb; }

  /* Tabs */
  .em-tabs { display: flex; gap: 2px; margin-bottom: 16px; border-bottom: 2px solid #e2e8f0; }
  .em-tab { padding: 8px 20px; border: none; background: none; color: #64748b; font-size: 14px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all .15s; }
  .em-tab.active { color: #0f172a; border-bottom-color: #3b82f6; font-weight: 600; }
  .em-tab:hover:not(.active) { color: #0f172a; background: #f8fafc; border-radius: 4px 4px 0 0; }

  /* Filter bar */
  .em-filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  .em-filters select, .em-filters input { padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 13px; background: #fff; color: #1e293b; }
  .em-filters select:focus, .em-filters input:focus { outline: 1px solid #3b82f6; }
  .em-filters .reset-btn { padding: 6px 12px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 13px; color: #64748b; }
  .em-filters .reset-btn:hover { background: #e2e8f0; }

  /* Refresh indicator */
  .em-refresh { display: flex; align-items: center; gap: 8px; margin-left: auto; font-size: 12px; color: #94a3b8; }
  .em-refresh-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

  /* Event card */
  .em-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 8px; overflow: hidden; transition: box-shadow .15s; }
  .em-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .em-card-header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; cursor: pointer; user-select: none; }
  .em-card-icon { font-size: 18px; flex-shrink: 0; }
  .em-card-title { font-size: 14px; font-weight: 500; color: #0f172a; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .em-card-meta { font-size: 12px; color: #94a3b8; flex-shrink: 0; }
  .em-status-badge { padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
  .em-status-badge.waiting { background: #eff6ff; color: #2563eb; }
  .em-status-badge.fired { background: #f0fdf4; color: #16a34a; }
  .em-status-badge.error { background: #fef2f2; color: #dc2626; }
  .em-status-badge.manual_fallback { background: #fffbeb; color: #d97706; }
  .em-card-body { padding: 0 16px 12px; border-top: 1px solid #f1f5f9; }
  .em-detail-grid { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; font-size: 12px; margin-top: 10px; }
  .em-detail-grid .key { color: #94a3b8; font-weight: 500; }
  .em-detail-grid .val { color: #374151; font-family: monospace; word-break: break-all; }
  .em-context { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #e2e8f0; font-size: 12px; color: #64748b; }
  .em-context a { color: #3b82f6; text-decoration: none; }
  .em-context a:hover { text-decoration: underline; }
  .em-error-text { font-size: 12px; color: #dc2626; margin-top: 6px; background: #fef2f2; padding: 6px 10px; border-radius: 4px; }
  .em-confidence { font-size: 12px; color: #d97706; margin-top: 6px; background: #fffbeb; padding: 6px 10px; border-radius: 4px; }

  /* Timeline sections */
  .em-section { margin-bottom: 20px; }
  .em-section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: #94a3b8; margin-bottom: 8px; padding: 4px 0; border-bottom: 1px solid #f1f5f9; display: flex; align-items: center; gap: 8px; }
  .em-section-title.overdue { color: #dc2626; border-bottom-color: #fee2e2; }
  .em-section-title.today { color: #2563eb; border-bottom-color: #dbeafe; }
  .em-section-count { background: #f1f5f9; border-radius: 10px; padding: 1px 7px; font-size: 10px; color: #64748b; }

  /* By Process tree */
  .em-process-group { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .em-process-header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; cursor: pointer; background: #f8fafc; }
  .em-process-name { font-size: 14px; font-weight: 600; color: #0f172a; flex: 1; }
  .em-process-meta { font-size: 12px; color: #94a3b8; }
  .em-instance-group { border-top: 1px solid #f1f5f9; }
  .em-instance-header { display: flex; align-items: center; gap: 8px; padding: 8px 16px 8px 32px; cursor: pointer; background: #fff; }
  .em-instance-name { font-size: 13px; color: #475569; flex: 1; }
  .em-instance-events { padding: 0 16px 8px 48px; }
  .em-tree-event { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; color: #64748b; border-left: 2px solid #f1f5f9; padding-left: 8px; margin: 2px 0; }
  .em-tree-event-dot { flex-shrink: 0; }
  .em-tree-event-label { flex: 1; }
  .em-tree-event-time { color: #94a3b8; }

  /* By Source groups */
  .em-source-group { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .em-source-header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
  .em-source-icon { font-size: 20px; flex-shrink: 0; }
  .em-source-name { font-size: 14px; font-weight: 600; color: #0f172a; flex: 1; }
  .em-source-count { font-size: 12px; color: #64748b; }
  .em-adapter-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .em-adapter-dot.available { background: #22c55e; }
  .em-adapter-dot.degraded { background: #f59e0b; }
  .em-adapter-dot.unavailable { background: #ef4444; }
  .em-source-body { padding: 0 16px 14px; border-top: 1px solid #f8fafc; }
  .em-source-detail { font-size: 12px; color: #64748b; margin-top: 6px; display: flex; gap: 16px; flex-wrap: wrap; }
  .em-source-detail span { color: #374151; }

  /* History */
  .em-history-list { display: flex; flex-direction: column; gap: 4px; }
  .em-history-item { display: grid; grid-template-columns: 160px 120px 1fr; gap: 12px; padding: 8px 12px; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 12px; }
  .em-history-time { color: #64748b; font-family: monospace; }
  .em-history-kind { color: #3b82f6; font-weight: 500; }
  .em-history-label { color: #374151; }

  /* Empty / loading states */
  .em-empty { text-align: center; padding: 48px; color: #94a3b8; font-size: 14px; }
  .em-loading { text-align: center; padding: 48px; color: #94a3b8; }
  .em-error-banner { background: #fef2f2; border: 1px solid #fecaca; color: #dc2626; padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
`;
