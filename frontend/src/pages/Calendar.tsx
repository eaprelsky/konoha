/**
 * Calendar — Outlook-style visual calendar.
 * Sources: reminders, work items (tasks with deadlines), process runs.
 * Views: week (default), month.
 * Left panel: filters by event type + process.
 */
import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';
import type { Workflow } from '../api/types';

// ── Types ─────────────────────────────────────────────────────────────────────

type EventType = 'reminder' | 'task' | 'run';

interface CalEvent {
  id: string;
  type: EventType;
  title: string;
  start: Date;
  end?: Date;
  color: string;
  processId?: string;
  processName?: string;
  status?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Mon = start
  r.setDate(r.getDate() + diff);
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function fmtShort(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function fmtFull(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function monthTitle(d: Date): string {
  return d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
}

const TYPE_COLORS: Record<EventType, string> = {
  reminder: '#f59e0b',
  task:     '#6366f1',
  run:      '#3b82f6',
};

const TYPE_LABELS: Record<EventType, string> = {
  reminder: 'Напоминание',
  task:     'Задача',
  run:      'Прогон',
};

const WEEK_DAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
  .cal-root { display: flex; height: calc(100vh - 96px); overflow: hidden; background: #f8fafc; }

  /* Left panel */
  .cal-left { width: 210px; flex-shrink: 0; background: #fff; border-right: 1px solid #e2e8f0;
    display: flex; flex-direction: column; overflow-y: auto; padding: 14px 12px; gap: 16px; }
  .cal-left h3 { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase;
    letter-spacing: .06em; margin-bottom: 6px; }
  .cal-filter-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #334155;
    cursor: pointer; padding: 3px 0; user-select: none; }
  .cal-filter-item input { width: 14px; height: 14px; cursor: pointer; accent-color: #6366f1; flex-shrink: 0; }
  .cal-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }

  /* Main area */
  .cal-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }

  /* Toolbar */
  .cal-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px;
    background: #fff; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; }
  .cal-toolbar h2 { font-size: 16px; font-weight: 700; color: #0f172a; flex: 1; }
  .cal-nav-btn { padding: 4px 11px; border: 1px solid #e2e8f0; border-radius: 6px;
    background: #fff; cursor: pointer; font-size: 16px; color: #475569; line-height: 1.4; }
  .cal-nav-btn:hover { background: #f1f5f9; }
  .cal-view-btns { display: flex; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; }
  .cal-view-btn { padding: 5px 13px; border: none; background: #fff; cursor: pointer;
    font-size: 13px; color: #64748b; border-left: 1px solid #e2e8f0; }
  .cal-view-btn:first-child { border-left: none; }
  .cal-view-btn.active { background: #eff6ff; color: #1d4ed8; font-weight: 600; }
  .cal-view-btn:hover:not(.active) { background: #f8fafc; }
  .cal-today-btn { padding: 5px 12px; border: 1px solid #6366f1; border-radius: 6px;
    background: #eff6ff; color: #6366f1; cursor: pointer; font-size: 13px; font-weight: 600; }
  .cal-today-btn:hover { background: #e0e7ff; }

  /* Week view */
  .cal-week { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .cal-week-head { display: grid; grid-template-columns: 50px repeat(7, 1fr);
    border-bottom: 2px solid #e2e8f0; background: #fff; flex-shrink: 0; }
  .cal-wh-cell { padding: 8px 4px; text-align: center; }
  .cal-wh-cell .wd { font-size: 10px; color: #64748b; font-weight: 700; text-transform: uppercase; }
  .cal-wh-cell .dd { font-size: 20px; font-weight: 700; color: #1e293b; line-height: 1.1; margin-top: 2px; }
  .cal-wh-cell.today .dd { background: #6366f1; color: #fff; border-radius: 50%;
    width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; }
  .cal-week-body { flex: 1; overflow-y: auto; display: flex; position: relative; }
  .cal-time-col { width: 50px; flex-shrink: 0; position: relative; }
  .cal-time-label { font-size: 10px; color: #94a3b8; text-align: right; padding-right: 6px;
    position: absolute; transform: translateY(-50%); right: 0; white-space: nowrap; }
  .cal-day-cols { flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); position: relative; }
  .cal-day-col { border-left: 1px solid #e2e8f0; position: relative; }
  .cal-day-col.today { background: rgba(99,102,241,.03); }
  .cal-hour-line { border-top: 1px solid #f1f5f9; position: absolute; left: 0; right: 0; }
  .cal-event { position: absolute; left: 2px; right: 2px; border-radius: 4px; padding: 2px 5px;
    font-size: 11px; font-weight: 600; overflow: hidden; cursor: pointer; z-index: 1;
    border-left: 3px solid; transition: filter .15s; }
  .cal-event:hover { filter: brightness(.92); }
  .cal-event-time { font-size: 10px; font-weight: 400; opacity: .7; }

  /* Month view */
  .cal-month { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .cal-month-head { display: grid; grid-template-columns: repeat(7, 1fr);
    background: #fff; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; }
  .cal-month-head-cell { padding: 8px 4px; text-align: center; font-size: 10px;
    font-weight: 700; color: #94a3b8; text-transform: uppercase; }
  .cal-month-grid { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(7, 1fr);
    grid-auto-rows: minmax(80px, 1fr); align-content: start; }
  .cal-month-cell { border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0;
    padding: 4px; background: #fff; overflow: hidden; }
  .cal-month-cell.other-month { background: #f8fafc; }
  .cal-month-cell.today-cell { background: rgba(99,102,241,.04); }
  .cal-month-day { font-size: 12px; font-weight: 600; color: #64748b; margin-bottom: 3px; }
  .cal-month-day.today-num { background: #6366f1; color: #fff; border-radius: 50%;
    width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; }
  .cal-month-event { border-radius: 3px; padding: 1px 5px; font-size: 11px; font-weight: 600;
    color: #fff; margin-bottom: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer; }
  .cal-month-event:hover { filter: brightness(.9); }
  .cal-more { font-size: 11px; color: #6366f1; cursor: pointer; padding: 1px 5px; font-weight: 600; }

  /* Tooltip */
  .cal-tooltip { position: fixed; background: #1e293b; color: #f8fafc; padding: 9px 13px;
    border-radius: 8px; font-size: 12px; pointer-events: none; z-index: 1000; max-width: 260px;
    box-shadow: 0 4px 16px rgba(0,0,0,.25); line-height: 1.6; }
  .cal-tooltip-title { font-weight: 700; margin-bottom: 2px; }
  .cal-tooltip-row { color: #94a3b8; font-size: 11px; }

  .cal-loading { flex: 1; display: flex; align-items: center; justify-content: center;
    color: #94a3b8; font-size: 14px; }
`;

// ── Component ─────────────────────────────────────────────────────────────────

export function Calendar() {
  const token = useToken();

  const [view, setView] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [showReminders, setShowReminders] = useState(true);
  const [showTasks, setShowTasks] = useState(true);
  const [showRuns, setShowRuns] = useState(true);
  const [processFilter, setProcessFilter] = useState('');
  const [tooltip, setTooltip] = useState<{ ev: CalEvent; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!token) return;
    api.workflows.list().then(setWorkflows).catch(() => {});
  }, [token]);

  const wfName = useCallback((id: string) =>
    workflows.find(w => w.id === id)?.name || id,
  [workflows]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [reminders, items, runsRes] = await Promise.all([
        api.reminders.list().catch(() => []),
        api.workitems.list({ status: 'pending' } as any).catch(() => []),
        api.runs.list({ limit: 200 } as any).then((r: any) => r.cases || []).catch(() => []),
      ]);

      const evts: CalEvent[] = [];

      for (const r of reminders as any[]) {
        evts.push({
          id: r.reminder_id,
          type: 'reminder',
          title: r.message,
          start: new Date(r.scheduled_at),
          color: TYPE_COLORS.reminder,
          processId: r.process_id,
          processName: r.process_id ? wfName(r.process_id) : undefined,
          status: r.status,
        });
      }

      for (const t of items as any[]) {
        if (!t.deadline) continue;
        evts.push({
          id: t.work_item_id,
          type: 'task',
          title: t.label,
          start: new Date(t.deadline),
          color: TYPE_COLORS.task,
          processId: t.process_id || undefined,
          processName: t.process_id ? wfName(t.process_id) : undefined,
          status: t.status,
        });
      }

      for (const run of runsRes as any[]) {
        evts.push({
          id: run.case_id,
          type: 'run',
          title: run.subject,
          start: new Date(run.created_at),
          color: TYPE_COLORS.run,
          processId: run.process_id,
          processName: wfName(run.process_id),
          status: run.status,
        });
      }

      setEvents(evts);
    } finally {
      setLoading(false);
    }
  }, [token, wfName]);

  useEffect(() => { load(); }, [load]);

  const visible = events.filter(e => {
    if (e.type === 'reminder' && !showReminders) return false;
    if (e.type === 'task' && !showTasks) return false;
    if (e.type === 'run' && !showRuns) return false;
    if (processFilter && e.processId !== processFilter) return false;
    return true;
  });

  function prev() {
    if (view === 'week') setAnchor(a => addDays(a, -7));
    else setAnchor(a => new Date(a.getFullYear(), a.getMonth() - 1, 1));
  }
  function next() {
    if (view === 'week') setAnchor(a => addDays(a, 7));
    else setAnchor(a => new Date(a.getFullYear(), a.getMonth() + 1, 1));
  }

  const title = view === 'week'
    ? (() => {
      const ws = startOfWeek(anchor);
      return `${fmtShort(ws)} — ${fmtShort(addDays(ws, 6))}, ${ws.getFullYear()}`;
    })()
    : monthTitle(anchor);

  const uniqueProcs = [...new Map(
    events.filter(e => e.processId).map(e => [e.processId!, e.processName || e.processId!])
  )];

  // ── Week view ──────────────────────────────────────────────────────────────
  function WeekView() {
    const ws = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const now = new Date();
    const HOUR_H = 42;

    return (
      <div className="cal-week">
        <div className="cal-week-head">
          <div />
          {days.map((d, i) => (
            <div key={i} className={`cal-wh-cell${sameDay(d, now) ? ' today' : ''}`}>
              <div className="wd">{WEEK_DAYS_RU[i]}</div>
              <div className="dd">{d.getDate()}</div>
            </div>
          ))}
        </div>
        <div className="cal-week-body">
          <div className="cal-time-col" style={{ minHeight: 24 * HOUR_H }}>
            {Array.from({ length: 24 }, (_, h) => h > 0 && (
              <div key={h} className="cal-time-label" style={{ top: h * HOUR_H }}>{h}:00</div>
            ))}
          </div>
          <div className="cal-day-cols" style={{ minHeight: 24 * HOUR_H }}>
            {days.map((day, di) => {
              const dayEvts = visible.filter(e => sameDay(e.start, day));
              return (
                <div key={di} className={`cal-day-col${sameDay(day, now) ? ' today' : ''}`}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="cal-hour-line" style={{ top: h * HOUR_H }} />
                  ))}
                  {dayEvts.map(ev => {
                    const top = (ev.start.getHours() + ev.start.getMinutes() / 60) * HOUR_H;
                    const dur = ev.end ? (ev.end.getTime() - ev.start.getTime()) / 3_600_000 : 0.75;
                    const height = Math.max(dur * HOUR_H, 22);
                    return (
                      <div
                        key={ev.id}
                        className="cal-event"
                        style={{ top, height, background: ev.color + '20', borderLeftColor: ev.color, color: ev.color }}
                        onMouseEnter={e => setTooltip({ ev, x: e.clientX + 14, y: e.clientY - 10 })}
                        onMouseLeave={() => setTooltip(null)}
                      >
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</div>
                        <div className="cal-event-time">{fmtTime(ev.start)}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Month view ─────────────────────────────────────────────────────────────
  function MonthView() {
    const ms = startOfMonth(anchor);
    const gs = startOfWeek(ms);
    const cells: Date[] = [];
    for (let d = new Date(gs); cells.length < 42; d = addDays(d, 1)) cells.push(new Date(d));
    const now = new Date();
    return (
      <div className="cal-month">
        <div className="cal-month-head">
          {WEEK_DAYS_RU.map(d => <div key={d} className="cal-month-head-cell">{d}</div>)}
        </div>
        <div className="cal-month-grid">
          {cells.map((day, i) => {
            const isOther = day.getMonth() !== anchor.getMonth();
            const isToday = sameDay(day, now);
            const dayEvts = visible.filter(e => sameDay(e.start, day));
            const shown = dayEvts.slice(0, 3);
            const extra = dayEvts.length - shown.length;
            return (
              <div key={i} className={`cal-month-cell${isOther ? ' other-month' : ''}${isToday ? ' today-cell' : ''}`}>
                <div className={`cal-month-day${isToday ? ' today-num' : ''}`}>{day.getDate()}</div>
                {shown.map(ev => (
                  <div key={ev.id} className="cal-month-event"
                    style={{ background: ev.color }}
                    onMouseEnter={e => setTooltip({ ev, x: e.clientX + 14, y: e.clientY - 10 })}
                    onMouseLeave={() => setTooltip(null)}
                  >{ev.title}</div>
                ))}
                {extra > 0 && <div className="cal-more">+{extra} ещё</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <Layout activePage="calendar.html">
      <style>{CSS}</style>
      <div className="cal-root" onClick={() => setTooltip(null)}>
        {/* Left panel */}
        <div className="cal-left">
          <div>
            <h3>Типы</h3>
            {(['reminder', 'task', 'run'] as EventType[]).map(t => {
              const checked = t === 'reminder' ? showReminders : t === 'task' ? showTasks : showRuns;
              const set = t === 'reminder' ? setShowReminders : t === 'task' ? setShowTasks : setShowRuns;
              return (
                <label key={t} className="cal-filter-item">
                  <input type="checkbox" checked={checked} onChange={e => set(e.target.checked)} />
                  <span className="cal-dot" style={{ background: TYPE_COLORS[t] }} />
                  {TYPE_LABELS[t]}
                </label>
              );
            })}
          </div>
          {uniqueProcs.length > 0 && (
            <div>
              <h3>Процесс</h3>
              <label className="cal-filter-item">
                <input type="radio" name="proc" checked={processFilter === ''} onChange={() => setProcessFilter('')} />
                Все
              </label>
              {uniqueProcs.map(([id, name]) => (
                <label key={id} className="cal-filter-item">
                  <input type="radio" name="proc" checked={processFilter === id} onChange={() => setProcessFilter(id)} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Main */}
        <div className="cal-main">
          <div className="cal-toolbar">
            <button className="cal-nav-btn" onClick={prev}>‹</button>
            <button className="cal-nav-btn" onClick={next}>›</button>
            <button className="cal-today-btn" onClick={() => setAnchor(new Date())}>Сегодня</button>
            <h2>{title}</h2>
            <div className="cal-view-btns">
              <button className={`cal-view-btn${view === 'week' ? ' active' : ''}`} onClick={() => setView('week')}>Неделя</button>
              <button className={`cal-view-btn${view === 'month' ? ' active' : ''}`} onClick={() => setView('month')}>Месяц</button>
            </div>
          </div>
          {loading
            ? <div className="cal-loading">Загрузка…</div>
            : view === 'week' ? <WeekView /> : <MonthView />
          }
        </div>

        {/* Tooltip */}
        {tooltip && (
          <div className="cal-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
            <div className="cal-tooltip-title">{tooltip.ev.title}</div>
            <div className="cal-tooltip-row">{fmtFull(tooltip.ev.start)}, {fmtTime(tooltip.ev.start)}</div>
            {tooltip.ev.processName && <div className="cal-tooltip-row">Процесс: {tooltip.ev.processName}</div>}
            {tooltip.ev.status && <div className="cal-tooltip-row">Статус: {tooltip.ev.status}</div>}
            <div className="cal-tooltip-row">{TYPE_LABELS[tooltip.ev.type]}</div>
          </div>
        )}
      </div>
    </Layout>
  );
}
