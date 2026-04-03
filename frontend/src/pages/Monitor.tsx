import { useState, useCallback, useEffect } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { RuntimeEvent, Case } from '../api/types';

const styles = `
  .mon-body { padding: 20px; }
  .container { max-width: 860px; margin: 0 auto; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; gap: 12px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .header-right { display: flex; gap: 8px; align-items: center; }
  .filter-select { padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
  .btn-refresh { padding: 6px 14px; background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .btn-refresh:hover { background: #e2e8f0; }
  .empty { text-align: center; padding: 60px; color: #94a3b8; font-size: 15px; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }

  /* Case card */
  .case-card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 16px; overflow: hidden; }
  .case-header { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid #f1f5f9; cursor: pointer; }
  .case-header:hover { background: #fafafa; }
  .case-status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .dot-running  { background: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.2); }
  .dot-done     { background: #22c55e; }
  .dot-error    { background: #ef4444; }
  .case-subject { font-weight: 600; color: #1e293b; font-size: 15px; flex: 1; }
  .case-meta    { font-size: 12px; color: #94a3b8; white-space: nowrap; }
  .case-process { font-size: 12px; color: #64748b; padding: 0 8px; border-left: 1px solid #e2e8f0; }
  .chevron      { color: #94a3b8; font-size: 12px; transition: transform .15s; }
  .chevron.open { transform: rotate(180deg); }

  /* Timeline */
  .timeline { padding: 0 18px 14px 18px; }
  .tl-item { display: flex; gap: 12px; padding: 8px 0; }
  .tl-item:not(:last-child) { border-bottom: 1px solid #f8fafc; }
  .tl-icon { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; flex-shrink: 0; margin-top: 1px; }
  .icon-created   { background: #dbeafe; }
  .icon-started   { background: #fef3c7; }
  .icon-completed { background: #dcfce7; }
  .icon-gateway   { background: #f3e8ff; }
  .icon-done      { background: #d1fae5; }
  .icon-error     { background: #fee2e2; }
  .icon-default   { background: #f1f5f9; }
  .tl-body        { flex: 1; }
  .tl-text        { font-size: 14px; color: #1e293b; line-height: 1.4; }
  .tl-text b      { font-weight: 600; }
  .tl-time        { font-size: 11px; color: #94a3b8; margin-top: 2px; }
`;

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

type EventIcon = { cls: string; emoji: string };

function getEventStyle(type: string): EventIcon {
  switch (type) {
    case 'case.created':    return { cls: 'icon-created',   emoji: '🚀' };
    case 'step.started':    return { cls: 'icon-started',   emoji: '▶️' };
    case 'step.completed':  return { cls: 'icon-completed', emoji: '✅' };
    case 'gateway.evaluated': return { cls: 'icon-gateway', emoji: '🔀' };
    case 'case.done':
    case 'case.completed':  return { cls: 'icon-done',      emoji: '🏁' };
    case 'case.error':      return { cls: 'icon-error',     emoji: '❌' };
    default:                return { cls: 'icon-default',   emoji: '•' };
  }
}

function humanizeEvent(ev: RuntimeEvent, subject: string): string {
  switch (ev.type) {
    case 'case.created':
      return `Кейс <b>${subject}</b> запущен по процессу <b>${ev.process_id || '—'}</b>`;
    case 'step.started':
      return `Шаг <b>${ev.label || ev.element_id || '—'}</b> начат`;
    case 'step.completed':
      return `Шаг <b>${ev.label || ev.element_id || '—'}</b> выполнен`;
    case 'gateway.evaluated':
      return `Шлюз <b>${ev.label || ev.element_id || '—'}</b> пройден`;
    case 'case.done':
    case 'case.completed':
      return `Кейс <b>${subject}</b> завершён`;
    case 'case.error':
      return `Кейс <b>${subject}</b> завершился с ошибкой`;
    default:
      return `${ev.type}${ev.label ? ` — ${ev.label}` : ''}`;
  }
}

interface CaseTimelineProps {
  kase: Case;
  events: RuntimeEvent[];
}

function CaseTimeline({ kase, events }: CaseTimelineProps) {
  const [open, setOpen] = useState(true);
  const statusDot = kase.status === 'running' ? 'dot-running' : kase.status === 'done' ? 'dot-done' : 'dot-error';
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return (
    <div className="case-card">
      <div className="case-header" onClick={() => setOpen(o => !o)}>
        <div className={`case-status-dot ${statusDot}`} />
        <div className="case-subject">{kase.subject || `Кейс #${shortId(kase.case_id)}`}</div>
        <div className="case-process">{kase.process_id}</div>
        <div className="case-meta">{formatTime(kase.created_at)}</div>
        <div className={`chevron ${open ? 'open' : ''}`}>▼</div>
      </div>
      {open && (
        <div className="timeline">
          {sorted.length === 0 && (
            <div style={{ padding: '12px 0', color: '#94a3b8', fontSize: 13 }}>Нет событий</div>
          )}
          {sorted.map(ev => {
            const { cls, emoji } = getEventStyle(ev.type);
            const text = humanizeEvent(ev, kase.subject);
            return (
              <div className="tl-item" key={ev.id}>
                <div className={`tl-icon ${cls}`}>{emoji}</div>
                <div className="tl-body">
                  <div className="tl-text" dangerouslySetInnerHTML={{ __html: text }} />
                  <div className="tl-time">{formatTime(ev.timestamp)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Monitor() {
  const token = useToken();
  const [cases, setCases] = useState<Case[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');

  const load = useCallback(() => {
    if (!token) return;
    Promise.all([
      api.cases.list({ limit: 50 }),
      api.events.list({ limit: 500 }),
    ])
      .then(([casesRes, eventsRes]) => {
        setCases(casesRes.cases);
        setEvents(eventsRes);
        setError(null);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 15000);

  const filteredCases = statusFilter
    ? cases.filter(c => c.status === statusFilter)
    : cases;

  // Sort: running first, then by created_at desc
  const sortedCases = [...filteredCases].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return b.created_at.localeCompare(a.created_at);
  });

  // Build case_id → events map
  const eventsByCase = new Map<string, RuntimeEvent[]>();
  for (const ev of events) {
    if (!ev.case_id) continue;
    if (!eventsByCase.has(ev.case_id)) eventsByCase.set(ev.case_id, []);
    eventsByCase.get(ev.case_id)!.push(ev);
  }

  return (
    <Layout activePage="monitor.html">
      <style>{styles}</style>
      <div className="mon-body">
        <div className="container">
          <div className="page-header">
            <h1>Монитор процессов</h1>
            <div className="header-right">
              <select className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">Все статусы</option>
                <option value="running">Выполняются</option>
                <option value="done">Завершены</option>
                <option value="error">Ошибки</option>
              </select>
              <button className="btn-refresh" onClick={load}>↺ Обновить</button>
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Загрузка…</div>}
          {!loading && sortedCases.length === 0 && (
            <div className="empty">Нет кейсов{statusFilter ? ` со статусом «${statusFilter}»` : ''}.</div>
          )}
          {!loading && sortedCases.map(kase => (
            <CaseTimeline
              key={kase.case_id}
              kase={kase}
              events={eventsByCase.get(kase.case_id) || []}
            />
          ))}
        </div>
      </div>
    </Layout>
  );
}
