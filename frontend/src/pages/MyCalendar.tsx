/**
 * MyCalendar — personal calendar for the User section.
 * Shows only tasks assigned to the current user and their personal reminders.
 * No process-level filtering — focused on "what do I need to do and when".
 *
 * Contrast with Calendar.tsx (Processes section) which shows all users' events
 * with a process-level filter.
 */
import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';

// ── Types ─────────────────────────────────────────────────────────────────────

type EventType = 'reminder' | 'task';

interface CalEvent {
  id: string;
  type: EventType;
  title: string;
  start: Date;
  color: string;
  processName?: string;
  status?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  r.setDate(r.getDate() + (day === 0 ? -6 : 1 - day));
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
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
};

const TYPE_LABELS: Record<EventType, string> = {
  reminder: 'Напоминание',
  task:     'Задача',
};

const WEEK_DAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// ── CSS (same structure as Calendar.tsx) ────────────────────────────────────

const CSS = `
  .mycal-root { display: flex; height: calc(100vh - 96px); overflow: hidden; background: #f8fafc; }

  .mycal-left { width: 210px; flex-shrink: 0; background: #fff; border-right: 1px solid #e2e8f0;
    display: flex; flex-direction: column; overflow-y: auto; padding: 14px 12px; gap: 16px; }
  .mycal-left h3 { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase;
    letter-spacing: .06em; margin-bottom: 6px; }
  .mycal-filter-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #334155;
    cursor: pointer; padding: 3px 0; user-select: none; }
  .mycal-filter-item input { width: 14px; height: 14px; cursor: pointer; accent-color: #6366f1; flex-shrink: 0; }
  .mycal-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }

  .mycal-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }

  .mycal-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 16px;
    background: #fff; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; }
  .mycal-toolbar h2 { font-size: 16px; font-weight: 700; color: #0f172a; flex: 1; }
  .mycal-subtitle { font-size: 12px; color: #6366f1; font-weight: 500; background: #eff6ff;
    padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
  .mycal-nav-btn { padding: 4px 11px; border: 1px solid #e2e8f0; border-radius: 6px;
    background: #fff; cursor: pointer; font-size: 16px; color: #475569; line-height: 1.4; }
  .mycal-nav-btn:hover { background: #f1f5f9; }
  .mycal-view-btns { display: flex; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; }
  .mycal-view-btn { padding: 5px 13px; border: none; background: #fff; cursor: pointer;
    font-size: 13px; color: #64748b; border-left: 1px solid #e2e8f0; }
  .mycal-view-btn:first-child { border-left: none; }
  .mycal-view-btn.active { background: #eff6ff; color: #1d4ed8; font-weight: 600; }
  .mycal-view-btn:hover:not(.active) { background: #f8fafc; }
  .mycal-today-btn { padding: 5px 12px; border: 1px solid #6366f1; border-radius: 6px;
    background: #eff6ff; color: #6366f1; cursor: pointer; font-size: 13px; font-weight: 600; }
  .mycal-today-btn:hover { background: #e0e7ff; }

  /* Week view */
  .mycal-week { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .mycal-week-head { display: grid; grid-template-columns: 50px repeat(7, 1fr);
    border-bottom: 2px solid #e2e8f0; background: #fff; flex-shrink: 0; }
  .mycal-wh-cell { padding: 8px 4px; text-align: center; }
  .mycal-wh-cell .wd { font-size: 10px; color: #64748b; font-weight: 700; text-transform: uppercase; }
  .mycal-wh-cell .dd { font-size: 20px; font-weight: 700; color: #1e293b; line-height: 1.1; margin-top: 2px; }
  .mycal-wh-cell.today .dd { background: #6366f1; color: #fff; border-radius: 50%;
    width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; }
  .mycal-week-body { flex: 1; overflow-y: auto; display: flex; position: relative; }
  .mycal-time-col { width: 50px; flex-shrink: 0; position: relative; }
  .mycal-time-label { font-size: 10px; color: #94a3b8; text-align: right; padding-right: 6px;
    position: absolute; transform: translateY(-50%); right: 0; white-space: nowrap; }
  .mycal-day-cols { flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); position: relative; }
  .mycal-day-col { border-left: 1px solid #e2e8f0; position: relative; }
  .mycal-day-col.today { background: rgba(99,102,241,.04); }
  .mycal-hour-line { border-top: 1px solid #f1f5f9; position: absolute; left: 0; right: 0; }
  .mycal-event { position: absolute; left: 2px; right: 2px; border-radius: 4px; padding: 2px 5px;
    font-size: 11px; font-weight: 600; overflow: hidden; cursor: pointer; z-index: 1;
    border-left: 3px solid; transition: filter .15s; }
  .mycal-event:hover { filter: brightness(.92); }
  .mycal-event-time { font-size: 10px; font-weight: 400; opacity: .7; }

  /* Month view */
  .mycal-month { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .mycal-month-head { display: grid; grid-template-columns: repeat(7, 1fr);
    background: #fff; border-bottom: 1px solid #e2e8f0; flex-shrink: 0; }
  .mycal-month-head-cell { padding: 8px 4px; text-align: center; font-size: 10px;
    font-weight: 700; color: #94a3b8; text-transform: uppercase; }
  .mycal-month-grid { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(7, 1fr);
    grid-auto-rows: minmax(80px, 1fr); align-content: start; }
  .mycal-month-cell { border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0;
    padding: 4px; background: #fff; overflow: hidden; }
  .mycal-month-cell.other-month { background: #f8fafc; }
  .mycal-month-cell.today-cell { background: rgba(99,102,241,.04); }
  .mycal-month-day { font-size: 12px; font-weight: 600; color: #64748b; margin-bottom: 3px; }
  .mycal-month-day.today-num { background: #6366f1; color: #fff; border-radius: 50%;
    width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; }
  .mycal-month-event { border-radius: 3px; padding: 1px 5px; font-size: 11px; font-weight: 600;
    color: #fff; margin-bottom: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer; }
  .mycal-month-event:hover { filter: brightness(.9); }
  .mycal-more { font-size: 11px; color: #6366f1; cursor: pointer; padding: 1px 5px; font-weight: 600; }

  .mycal-tooltip { position: fixed; background: #1e293b; color: #f8fafc; padding: 9px 13px;
    border-radius: 8px; font-size: 12px; pointer-events: none; z-index: 1000; max-width: 260px;
    box-shadow: 0 4px 16px rgba(0,0,0,.25); line-height: 1.6; }
  .mycal-tooltip-title { font-weight: 700; margin-bottom: 2px; }
  .mycal-tooltip-row { color: #94a3b8; font-size: 11px; }
  .mycal-loading { flex: 1; display: flex; align-items: center; justify-content: center;
    color: #94a3b8; font-size: 14px; }
`;

// ── Component ─────────────────────────────────────────────────────────────────

export function MyCalendar() {
  const token = useToken();

  const [view, setView] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showReminders, setShowReminders] = useState(true);
  const [showTasks, setShowTasks] = useState(true);
  const [tooltip, setTooltip] = useState<{ ev: CalEvent; x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      // Load only current user's items (pending reminders + own pending tasks with deadlines)
      const [reminders, items] = await Promise.all([
        api.reminders.list({ status: 'pending' }).catch(() => []),
        api.workitems.list({ status: 'pending' } as any).catch(() => []),
      ]);

      const evts: CalEvent[] = [];

      for (const r of reminders as any[]) {
        evts.push({
          id: r.reminder_id,
          type: 'reminder',
          title: r.message,
          start: new Date(r.scheduled_at),
          color: TYPE_COLORS.reminder,
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
          status: t.status,
        });
      }

      setEvents(evts);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const visible = events.filter(e => {
    if (e.type === 'reminder' && !showReminders) return false;
    if (e.type === 'task' && !showTasks) return false;
    return true;
  });

  const title = view === 'week'
    ? (() => {
      const ws = startOfWeek(anchor);
      return `${fmtShort(ws)} — ${fmtShort(addDays(ws, 6))}, ${ws.getFullYear()}`;
    })()
    : monthTitle(anchor);

  function WeekView() {
    const ws = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const now = new Date();
    const HOUR_H = 42;

    return (
      <div className="mycal-week">
        <div className="mycal-week-head">
          <div />
          {days.map((d, i) => (
            <div key={i} className={`mycal-wh-cell${sameDay(d, now) ? ' today' : ''}`}>
              <div className="wd">{WEEK_DAYS_RU[i]}</div>
              <div className="dd">{d.getDate()}</div>
            </div>
          ))}
        </div>
        <div className="mycal-week-body">
          <div className="mycal-time-col" style={{ minHeight: 24 * HOUR_H }}>
            {Array.from({ length: 24 }, (_, h) => h > 0 && (
              <div key={h} className="mycal-time-label" style={{ top: h * HOUR_H }}>{h}:00</div>
            ))}
          </div>
          <div className="mycal-day-cols" style={{ minHeight: 24 * HOUR_H }}>
            {days.map((day, di) => {
              const dayEvts = visible.filter(e => sameDay(e.start, day));
              return (
                <div key={di} className={`mycal-day-col${sameDay(day, now) ? ' today' : ''}`}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="mycal-hour-line" style={{ top: h * HOUR_H }} />
                  ))}
                  {dayEvts.map(ev => {
                    const top = (ev.start.getHours() + ev.start.getMinutes() / 60) * HOUR_H;
                    const height = 30;
                    return (
                      <div key={ev.id} className="mycal-event"
                        style={{ top, height, background: ev.color + '20', borderLeftColor: ev.color, color: ev.color }}
                        onMouseEnter={e => setTooltip({ ev, x: e.clientX + 14, y: e.clientY - 10 })}
                        onMouseLeave={() => setTooltip(null)}
                      >
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</div>
                        <div className="mycal-event-time">{fmtTime(ev.start)}</div>
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

  function MonthView() {
    const ms = startOfMonth(anchor);
    const gs = startOfWeek(ms);
    const cells: Date[] = [];
    for (let d = new Date(gs); cells.length < 42; d = addDays(d, 1)) cells.push(new Date(d));
    const now = new Date();
    return (
      <div className="mycal-month">
        <div className="mycal-month-head">
          {WEEK_DAYS_RU.map(d => <div key={d} className="mycal-month-head-cell">{d}</div>)}
        </div>
        <div className="mycal-month-grid">
          {cells.map((day, i) => {
            const isOther = day.getMonth() !== anchor.getMonth();
            const isToday = sameDay(day, now);
            const dayEvts = visible.filter(e => sameDay(e.start, day));
            const shown = dayEvts.slice(0, 3);
            const extra = dayEvts.length - shown.length;
            return (
              <div key={i} className={`mycal-month-cell${isOther ? ' other-month' : ''}${isToday ? ' today-cell' : ''}`}>
                <div className={`mycal-month-day${isToday ? ' today-num' : ''}`}>{day.getDate()}</div>
                {shown.map(ev => (
                  <div key={ev.id} className="mycal-month-event"
                    style={{ background: ev.color }}
                    onMouseEnter={e => setTooltip({ ev, x: e.clientX + 14, y: e.clientY - 10 })}
                    onMouseLeave={() => setTooltip(null)}
                  >{ev.title}</div>
                ))}
                {extra > 0 && <div className="mycal-more">+{extra} ещё</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <Layout activePage="my-calendar.html">
      <style>{CSS}</style>
      <div className="mycal-root" onClick={() => setTooltip(null)}>
        {/* Left panel */}
        <div className="mycal-left">
          <div>
            <h3>Типы</h3>
            {(['reminder', 'task'] as EventType[]).map(t => {
              const checked = t === 'reminder' ? showReminders : showTasks;
              const set = t === 'reminder' ? setShowReminders : setShowTasks;
              return (
                <label key={t} className="mycal-filter-item">
                  <input type="checkbox" checked={checked} onChange={e => set(e.target.checked)} />
                  <span className="mycal-dot" style={{ background: TYPE_COLORS[t] }} />
                  {TYPE_LABELS[t]}
                </label>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5, padding: '8px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0' }}>
            Личный календарь — только ваши задачи и напоминания
          </div>
        </div>

        {/* Main */}
        <div className="mycal-main">
          <div className="mycal-toolbar">
            <button className="mycal-nav-btn" onClick={() => view === 'week' ? setAnchor(a => addDays(a, -7)) : setAnchor(a => new Date(a.getFullYear(), a.getMonth() - 1, 1))}>‹</button>
            <button className="mycal-nav-btn" onClick={() => view === 'week' ? setAnchor(a => addDays(a, 7)) : setAnchor(a => new Date(a.getFullYear(), a.getMonth() + 1, 1))}>›</button>
            <button className="mycal-today-btn" onClick={() => setAnchor(new Date())}>Сегодня</button>
            <h2>{title}</h2>
            <span className="mycal-subtitle">Мой календарь</span>
            <div className="mycal-view-btns">
              <button className={`mycal-view-btn${view === 'week' ? ' active' : ''}`} onClick={() => setView('week')}>Неделя</button>
              <button className={`mycal-view-btn${view === 'month' ? ' active' : ''}`} onClick={() => setView('month')}>Месяц</button>
            </div>
          </div>
          {loading
            ? <div className="mycal-loading">Загрузка…</div>
            : view === 'week' ? <WeekView /> : <MonthView />
          }
        </div>

        {tooltip && (
          <div className="mycal-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
            <div className="mycal-tooltip-title">{tooltip.ev.title}</div>
            <div className="mycal-tooltip-row">{fmtFull(tooltip.ev.start)}, {fmtTime(tooltip.ev.start)}</div>
            {tooltip.ev.status && <div className="mycal-tooltip-row">Статус: {tooltip.ev.status}</div>}
            <div className="mycal-tooltip-row">{TYPE_LABELS[tooltip.ev.type]}</div>
          </div>
        )}
      </div>
    </Layout>
  );
}
