/**
 * MyCalendar — personal calendar for the User section.
 * Shows only tasks assigned to the current user and their personal reminders.
 * No process-level filtering — focused on "what do I need to do and when".
 *
 * Contrast with Calendar.tsx (Processes section) which shows all users' events
 * with a process-level filter.
 */
import { useState, useEffect, useCallback } from 'react';
import { useToken } from '@core/context/TokenContext';
import { api } from '@core/api/client';
import './MyCalendar.css';

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
    <>
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
    </>
  );
}
