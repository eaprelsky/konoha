/**
 * Calendar — stub page (full implementation depends on #238 WorkCalendar).
 * Shows a placeholder until WorkCalendar service is ready.
 */
import { Layout } from '../components/Layout';

const lang = document.documentElement.lang || 'ru';

const CSS = `
  .cal-root { padding: 40px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 400px; }
  .cal-icon { font-size: 64px; margin-bottom: 20px; opacity: .5; }
  .cal-title { font-size: 22px; font-weight: 700; color: #0f172a; margin-bottom: 10px; }
  .cal-desc { font-size: 15px; color: #64748b; text-align: center; max-width: 480px; line-height: 1.6; }
  .cal-badge { display: inline-block; margin-top: 20px; padding: 6px 14px; background: #fef3c7; color: #d97706; border-radius: 20px; font-size: 13px; font-weight: 600; }
  .cal-sources { margin-top: 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; width: 100%; max-width: 480px; }
  .cal-sources h3 { font-size: 13px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 10px; }
  .cal-source { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 13px; color: #64748b; }
  .cal-source-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
`;

const SOURCES = [
  { color: '#6366f1', labelRu: 'Таймерные события процессов',   labelEn: 'Process timer events' },
  { color: '#3b82f6', labelRu: 'Дедлайны шагов',               labelEn: 'Step deadlines' },
  { color: '#f59e0b', labelRu: 'Напоминания',                  labelEn: 'Reminders' },
  { color: '#22c55e', labelRu: 'Назначенные задачи',           labelEn: 'Assigned tasks' },
];

export function Calendar() {
  return (
    <Layout activePage="calendar.html">
      <style>{CSS}</style>
      <div className="cal-root">
        <div className="cal-icon">📅</div>
        <h1 className="cal-title">{lang === 'ru' ? 'Календарь' : 'Calendar'}</h1>
        <p className="cal-desc">
          {lang === 'ru'
            ? 'Визуальный календарь (Outlook-стиль) с событиями процессов, дедлайнами и напоминаниями. Будет доступен после реализации WorkCalendar (#238).'
            : 'Visual calendar (Outlook-style) with process events, deadlines, and reminders. Available after WorkCalendar (#238) is implemented.'}
        </p>
        <span className="cal-badge">
          {lang === 'ru' ? 'В разработке — ожидает #238' : 'In progress — pending #238'}
        </span>

        <div className="cal-sources">
          <h3>{lang === 'ru' ? 'Источники событий (запланировано)' : 'Event sources (planned)'}</h3>
          {SOURCES.map((s, i) => (
            <div key={i} className="cal-source">
              <div className="cal-source-dot" style={{ background: s.color }} />
              {lang === 'ru' ? s.labelRu : s.labelEn}
            </div>
          ))}
        </div>
      </div>
    </Layout>
  );
}
