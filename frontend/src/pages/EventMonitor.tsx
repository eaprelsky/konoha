import { useState, useCallback, useEffect, useRef } from 'react';
import { useInterval } from '../hooks/useApi';
import { useSetSubtitle } from '../context/SubtitleContext';
import { useI18n } from '../context/I18nContext';
import { api } from '../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

type UiStatus = 'waiting' | 'fired' | 'error' | 'manual_fallback';

interface Subscription {
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

interface Summary {
  total: number;
  waiting: number;
  fired_today: number;
  errors: number;
  manual_fallback: number;
}

interface HistoryEntry {
  subscription_id: string;
  event_id: string;
  event_label?: string;
  process_id: string;
  process_name?: string;
  instance_id: string;
  trigger_kind: string;
  fired_at: string;
  source_data: Record<string, any>;
}

interface AdapterStatus {
  name: string;
  status: 'available' | 'degraded' | 'unavailable';
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  error_count: number;
  active_listeners: number;
}

type Tab = 'timeline' | 'by-process' | 'by-source';

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = `
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRIGGER_ICONS: Record<string, string> = {
  timer: '⏰',
  delay_after: '⏳',
  message: '📨',
  condition: '🔍',
  manual: '✋',
  system: '🔗',
};

const STATUS_LABELS: Record<UiStatus, string> = {
  waiting: 'Ожидает',
  fired: 'Сработал',
  error: 'Ошибка',
  manual_fallback: 'Вручную',
};

const SOURCE_ICONS: Record<string, string> = {
  bitrix: '📋',
  telegram: '💬',
  tracker: '📌',
  konoha: '🔗',
  timer: '⏰',
  manual: '✋',
};

function triggerIcon(trigger: Record<string, any>): string {
  return TRIGGER_ICONS[trigger.kind] ?? '⚙️';
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDateShort(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const itemDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (itemDay.getTime() === today.getTime()) {
    return 'Сегодня ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function getSubSource(trigger: Record<string, any>): string {
  return trigger.source ?? trigger.data_source ?? trigger.kind ?? 'unknown';
}

// ── EventCard — data-driven trigger details ───────────────────────────────────

function TriggerDetails({ trigger }: { trigger: Record<string, any> }) {
  const fields = Object.entries(trigger).filter(([k]) => k !== 'kind');
  return (
    <div className="em-detail-grid">
      <span className="key">Тип</span>
      <span className="val">{trigger.kind}</span>
      {fields.map(([k, v]) => (
        <span key={k} className="key">{k}</span>
      ))}
      {fields.map(([k, v]) => (
        <span key={k + '_v'} className="val">
          {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}
        </span>
      ))}
    </div>
  );
}

function EventCard({ sub, defaultOpen = false }: { sub: Subscription; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="em-card">
      <div className="em-card-header" onClick={() => setOpen(o => !o)}>
        <span className="em-card-icon">{triggerIcon(sub.trigger)}</span>
        <span className="em-card-title">
          {sub.event_label ?? sub.event_id}
        </span>
        <span className={`em-status-badge ${sub.ui_status}`}>
          {STATUS_LABELS[sub.ui_status]}
        </span>
        {sub.ui_status === 'waiting' && sub.next_fire_at && (
          <span className="em-card-meta">{formatDateShort(sub.next_fire_at)}</span>
        )}
        {sub.ui_status === 'fired' && sub.last_fired_at && (
          <span className="em-card-meta">{formatDateShort(sub.last_fired_at)}</span>
        )}
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className="em-card-body">
          {sub.error && <div className="em-error-text">⚠ {sub.error}</div>}

          <TriggerDetails trigger={sub.trigger} />

          {/* Extra stats */}
          <div className="em-detail-grid" style={{ marginTop: 8 }}>
            {sub.fire_count !== undefined && <>
              <span className="key">Срабатываний</span>
              <span className="val">{sub.fire_count}</span>
            </>}
            {sub.next_fire_at && <>
              <span className="key">Следующий огонь</span>
              <span className="val">{formatDate(sub.next_fire_at)}</span>
            </>}
            {sub.last_fired_at && <>
              <span className="key">Последний огонь</span>
              <span className="val">{formatDate(sub.last_fired_at)}</span>
            </>}
            {sub.last_poll_at && <>
              <span className="key">Последний опрос</span>
              <span className="val">{formatDate(sub.last_poll_at)} (результат: {String(sub.last_poll_result ?? '?')})</span>
            </>}
            <span className="key">Подписан</span>
            <span className="val">{formatDate(sub.subscribed_at)}</span>
            <span className="key">Режим</span>
            <span className="val">{sub.mode}</span>
          </div>

          <div className="em-context">
            Процесс: <a href={`/ui/editor/${sub.process_id}`}>{sub.process_name ?? sub.process_id}</a>
            {' · '}
            Экземпляр: <a href={`/ui/cases.html?id=${sub.instance_id}`}>{sub.instance_id}</a>
            {' · '}
            Узел: {sub.event_id}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Timeline section ──────────────────────────────────────────────────────────

function TimelineSection({ title, subs, className }: { title: string; subs: Subscription[]; className?: string }) {
  if (subs.length === 0) return null;
  return (
    <div className="em-section">
      <div className={`em-section-title${className ? ' ' + className : ''}`}>
        {title}
        <span className="em-section-count">{subs.length}</span>
      </div>
      {subs.map(s => <EventCard key={s.id} sub={s} />)}
    </div>
  );
}

function TimelineView({ subs }: { subs: Subscription[] }) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const weekEnd = new Date(todayStart.getTime() + 7 * 86400 * 1000);

  const overdue = subs.filter(s =>
    s.ui_status === 'error' ||
    (s.ui_status === 'waiting' && s.next_fire_at && new Date(s.next_fire_at) < now),
  );
  const waitingNoTime = subs.filter(s =>
    s.ui_status === 'waiting' && !s.next_fire_at && s.trigger.kind !== 'timer',
  );
  const manual = subs.filter(s => s.ui_status === 'manual_fallback');
  const today = subs.filter(s =>
    s.ui_status === 'waiting' && s.next_fire_at &&
    new Date(s.next_fire_at) >= todayStart && new Date(s.next_fire_at) <= todayEnd,
  ).sort((a, b) => (a.next_fire_at ?? '').localeCompare(b.next_fire_at ?? ''));
  const thisWeek = subs.filter(s =>
    s.ui_status === 'waiting' && s.next_fire_at &&
    new Date(s.next_fire_at) > todayEnd && new Date(s.next_fire_at) <= weekEnd,
  ).sort((a, b) => (a.next_fire_at ?? '').localeCompare(b.next_fire_at ?? ''));
  const later = subs.filter(s =>
    s.ui_status === 'waiting' && s.next_fire_at && new Date(s.next_fire_at) > weekEnd,
  ).sort((a, b) => (a.next_fire_at ?? '').localeCompare(b.next_fire_at ?? ''));
  const fired = subs.filter(s => s.ui_status === 'fired')
    .sort((a, b) => (b.last_fired_at ?? '').localeCompare(a.last_fired_at ?? ''))
    .slice(0, 20);

  return (
    <div>
      <TimelineSection title="Просрочено" subs={overdue} className="overdue" />
      <TimelineSection title="Ожидают (без расписания)" subs={[...waitingNoTime, ...manual]} />
      <TimelineSection title="Сегодня" subs={today} className="today" />
      <TimelineSection title="Эта неделя" subs={thisWeek} />
      <TimelineSection title="Позже" subs={later} />
      {fired.length > 0 && (
        <TimelineSection title={`Сработавшие (последние ${fired.length})`} subs={fired} />
      )}
      {subs.length === 0 && <div className="em-empty">Нет подписок</div>}
    </div>
  );
}

// ── By Process view ───────────────────────────────────────────────────────────

const STATUS_DOTS: Record<UiStatus, string> = {
  waiting: '◐',
  fired: '●',
  error: '✕',
  manual_fallback: '⚡',
};

function ByProcessView({ subs }: { subs: Subscription[] }) {
  const [openProcesses, setOpenProcesses] = useState<Set<string>>(new Set());
  const [openInstances, setOpenInstances] = useState<Set<string>>(new Set());

  const byProcess = subs.reduce<Record<string, Subscription[]>>((acc, s) => {
    if (!acc[s.process_id]) acc[s.process_id] = [];
    acc[s.process_id].push(s);
    return acc;
  }, {});

  if (Object.keys(byProcess).length === 0) {
    return <div className="em-empty">Нет подписок</div>;
  }

  return (
    <div>
      {Object.entries(byProcess).map(([processId, psubs]) => {
        const processOpen = openProcesses.has(processId);
        const processName = psubs[0]?.process_name ?? processId;
        const byInstance = psubs.reduce<Record<string, Subscription[]>>((acc, s) => {
          if (!acc[s.instance_id]) acc[s.instance_id] = [];
          acc[s.instance_id].push(s);
          return acc;
        }, {});

        return (
          <div key={processId} className="em-process-group">
            <div className="em-process-header" onClick={() => setOpenProcesses(s => {
              const n = new Set(s);
              n.has(processId) ? n.delete(processId) : n.add(processId);
              return n;
            })}>
              <span style={{ fontSize: 13 }}>{processOpen ? '▼' : '▶'}</span>
              <span className="em-process-name">{processName}</span>
              <span className="em-process-meta">
                {Object.keys(byInstance).length} экз. · {psubs.length} подп.
                {psubs.some(s => s.ui_status === 'error') && ' · ⚠ ошибки'}
              </span>
            </div>
            {processOpen && Object.entries(byInstance).map(([instanceId, isubs]) => {
              const instOpen = openInstances.has(instanceId);
              return (
                <div key={instanceId} className="em-instance-group">
                  <div className="em-instance-header" onClick={() => setOpenInstances(s => {
                    const n = new Set(s);
                    n.has(instanceId) ? n.delete(instanceId) : n.add(instanceId);
                    return n;
                  })}>
                    <span style={{ fontSize: 12 }}>{instOpen ? '▼' : '▶'}</span>
                    <span className="em-instance-name">
                      {instanceId}
                    </span>
                    <span className="em-process-meta">{isubs.length} событий</span>
                  </div>
                  {instOpen && (
                    <div className="em-instance-events">
                      {isubs.map(s => (
                        <div key={s.id} className="em-tree-event">
                          <span className="em-tree-event-dot">{STATUS_DOTS[s.ui_status]}</span>
                          <span className="em-tree-event-label">
                            {s.event_label ?? s.event_id}
                          </span>
                          <span className={`em-status-badge ${s.ui_status}`} style={{ fontSize: 10 }}>
                            {STATUS_LABELS[s.ui_status]}
                          </span>
                          <span className="em-tree-event-time">
                            {s.next_fire_at ? formatDateShort(s.next_fire_at) : formatDateShort(s.last_fired_at)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ── By Source view ────────────────────────────────────────────────────────────

function BySourceView({ subs, adapters }: { subs: Subscription[]; adapters: AdapterStatus[] }) {
  const adapterMap = new Map(adapters.map(a => [a.name, a]));

  const bySource = subs.reduce<Record<string, Subscription[]>>((acc, s) => {
    const src = getSubSource(s.trigger);
    if (!acc[src]) acc[src] = [];
    acc[src].push(s);
    return acc;
  }, {});

  // Merge sources from both subscriptions and known adapters
  const allSources = new Set([...Object.keys(bySource), ...adapters.map(a => a.name)]);

  if (allSources.size === 0) {
    return <div className="em-empty">Нет подписок</div>;
  }

  return (
    <div>
      {Array.from(allSources).map(src => {
        const ssubs = bySource[src] ?? [];
        const adapter = adapterMap.get(src);
        const icon = SOURCE_ICONS[src] ?? '🔌';
        const kindCounts = ssubs.reduce<Record<string, number>>((acc, s) => {
          const k = s.trigger.kind;
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {});

        return (
          <div key={src} className="em-source-group">
            <div className="em-source-header">
              <span className="em-source-icon">{icon}</span>
              <span className="em-source-name" style={{ textTransform: 'capitalize' }}>{src}</span>
              <span className="em-source-count">{ssubs.length} подписок</span>
              {adapter && (
                <>
                  <span className={`em-adapter-dot ${adapter.status}`} />
                  <span style={{ fontSize: 12, color: '#64748b' }}>{
                    adapter.status === 'available' ? 'доступен' :
                    adapter.status === 'degraded' ? 'деградация' : 'недоступен'
                  }</span>
                </>
              )}
            </div>
            {(ssubs.length > 0 || adapter) && (
              <div className="em-source-body">
                {Object.entries(kindCounts).length > 0 && (
                  <div className="em-source-detail">
                    {Object.entries(kindCounts).map(([k, c]) => (
                      <span key={k}>{k}: <span>{c}</span></span>
                    ))}
                  </div>
                )}
                {adapter && (
                  <div className="em-source-detail" style={{ marginTop: 6 }}>
                    {adapter.last_success_at && (
                      <span>Последний успех: <span>{formatDate(adapter.last_success_at)}</span></span>
                    )}
                    {adapter.active_listeners > 0 && (
                      <span>Активных слушателей: <span>{adapter.active_listeners}</span></span>
                    )}
                    {adapter.last_error && (
                      <span style={{ color: '#dc2626' }}>Ошибка: <span>{adapter.last_error}</span></span>
                    )}
                  </div>
                )}
                {ssubs.length > 0 && (() => {
                  const nextFire = ssubs
                    .filter(s => s.next_fire_at)
                    .sort((a, b) => (a.next_fire_at ?? '').localeCompare(b.next_fire_at ?? ''))[0];
                  return nextFire ? (
                    <div className="em-source-detail">
                      <span>Ближайший огонь: <span>{formatDate(nextFire.next_fire_at)} ({nextFire.event_label ?? nextFire.event_id})</span></span>
                    </div>
                  ) : null;
                })()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function EventMonitor() {
  const { lang } = useI18n();
  const [tab, setTab] = useState<Tab>('timeline');
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, waiting: 0, fired_today: 0, errors: 0, manual_fallback: 0 });
  const [adapters, setAdapters] = useState<AdapterStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('');

  // Filters
  const [filterKind, setFilterKind] = useState('');
  const [filterSource, setFilterSource] = useState('');
  const [filterProcess, setFilterProcess] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Sync filters to URL
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('kind')) setFilterKind(p.get('kind')!);
    if (p.get('source')) setFilterSource(p.get('source')!);
    if (p.get('process')) setFilterProcess(p.get('process')!);
    if (p.get('status')) setFilterStatus(p.get('status')!);
    if (p.get('tab')) setTab(p.get('tab') as Tab);
  }, []);

  function updateUrl(updates: Record<string, string>) {
    const p = new URLSearchParams(window.location.search);
    Object.entries(updates).forEach(([k, v]) => v ? p.set(k, v) : p.delete(k));
    window.history.replaceState({}, '', '?' + p.toString());
  }

  const load = useCallback(async () => {
    try {
      const [subsRes, adaptersRes] = await Promise.all([
        api.eventMonitor.subscriptions({
          trigger_kind: filterKind || undefined,
          source: filterSource || undefined,
          process_id: filterProcess || undefined,
          status: filterStatus || undefined,
        }),
        api.eventMonitor.adaptersStatus().catch(() => ({ adapters: [] })),
      ]);
      setSubs(subsRes.subscriptions);
      setSummary(subsRes.summary);
      setAdapters(adaptersRes.adapters);
      setLastUpdate(new Date().toLocaleTimeString('ru-RU'));
      setError(null);
      setLoading(false);
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }, [filterKind, filterSource, filterProcess, filterStatus]);

  useInterval(load, 30000);
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      load();
    }
  }, [load]);

  useEffect(() => {
    load();
  }, [filterKind, filterSource, filterProcess, filterStatus]);

  function resetFilters() {
    setFilterKind('');
    setFilterSource('');
    setFilterProcess('');
    setFilterStatus('');
    updateUrl({ kind: '', source: '', process: '', status: '' });
  }

  // Unique processes for filter dropdown
  const processes = Array.from(new Set(subs.map(s => s.process_id))).filter(Boolean);

  const badge = summary.errors + summary.manual_fallback;
  useSetSubtitle(badge > 0 ? `${badge} требуют внимания` : undefined);

  return (
    <>
      <style>{styles}</style>
      <div className="em-body">
        <div className="em-container">

          {/* Summary counters */}
          <div className="em-summary">
            <div className="em-counter info">
              <div className="val">{summary.total}</div>
              <div className="lbl">Всего</div>
            </div>
            <div className="em-counter ok">
              <div className="val">{summary.waiting}</div>
              <div className="lbl">Ожидают</div>
            </div>
            <div className="em-counter ok">
              <div className="val">{summary.fired_today}</div>
              <div className="lbl">Сегодня</div>
            </div>
            <div className="em-counter err">
              <div className="val">{summary.errors}</div>
              <div className="lbl">Ошибки</div>
            </div>
            <div className="em-counter warn">
              <div className="val">{summary.manual_fallback}</div>
              <div className="lbl">Вручную</div>
            </div>
            <div className="em-refresh" style={{ marginLeft: 'auto' }}>
              <span className="em-refresh-dot" />
              Обновлено: {lastUpdate || '—'} (30s)
            </div>
          </div>

          {error && <div className="em-error-banner">Ошибка загрузки: {error}</div>}

          {/* Tabs */}
          <div className="em-tabs">
            {([
              ['timeline', lang === 'ru' ? 'Лента' : 'Timeline'],
              ['by-process', lang === 'ru' ? 'По процессу' : 'By Process'],
              ['by-source', lang === 'ru' ? 'По источнику' : 'By Source'],
            ] as [Tab, string][]).map(([t, label]) => (
              <button
                key={t}
                className={`em-tab${tab === t ? ' active' : ''}`}
                onClick={() => { setTab(t); updateUrl({ tab: t }); }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Filter bar */}
          <div className="em-filters">
            <select value={filterKind} onChange={e => { setFilterKind(e.target.value); updateUrl({ kind: e.target.value }); }}>
              <option value="">Все типы</option>
              <option value="timer">Timer</option>
              <option value="delay_after">Delay After</option>
              <option value="message">Message</option>
              <option value="condition">Condition</option>
              <option value="manual">Manual</option>
              <option value="system">System</option>
            </select>
            <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); updateUrl({ status: e.target.value }); }}>
              <option value="">Все статусы</option>
              <option value="waiting">Ожидает</option>
              <option value="fired">Сработал</option>
              <option value="error">Ошибка</option>
              <option value="manual_fallback">Вручную</option>
            </select>
            <select value={filterProcess} onChange={e => { setFilterProcess(e.target.value); updateUrl({ process: e.target.value }); }}>
              <option value="">Все процессы</option>
              {processes.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filterSource} onChange={e => { setFilterSource(e.target.value); updateUrl({ source: e.target.value }); }}>
              <option value="">Все источники</option>
              <option value="bitrix">Битрикс24</option>
              <option value="telegram">Телеграм</option>
              <option value="tracker">Яндекс Трекер</option>
            </select>
            {(filterKind || filterStatus || filterProcess || filterSource) && (
              <button className="reset-btn" onClick={resetFilters}>Сбросить</button>
            )}
          </div>

          {/* Content */}
          {loading ? (
            <div className="em-loading">Загрузка...</div>
          ) : (
            <>
              {tab === 'timeline' && <TimelineView subs={subs} />}
              {tab === 'by-process' && <ByProcessView subs={subs} />}
              {tab === 'by-source' && <BySourceView subs={subs} adapters={adapters} />}
            </>
          )}
        </div>
      </div>
    </>
  );
}
