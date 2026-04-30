/**
 * TimelineSection and TimelineView sub-components for EventMonitor.
 * Extracted from EventMonitor.tsx (issue #448).
 */
import type { Subscription } from './eventMonitorUtils';
import { EventCard } from './EventCard';
import { useI18n } from '../context/I18nContext';

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

export function TimelineView({ subs }: { subs: Subscription[] }) {
  const { t } = useI18n();
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
      <TimelineSection title={t('eventMonitor.section.overdue')} subs={overdue} className="overdue" />
      <TimelineSection title={t('eventMonitor.section.unscheduled')} subs={[...waitingNoTime, ...manual]} />
      <TimelineSection title={t('eventMonitor.today')} subs={today} className="today" />
      <TimelineSection title={t('eventMonitor.section.thisWeek')} subs={thisWeek} />
      <TimelineSection title={t('eventMonitor.section.later')} subs={later} />
      {fired.length > 0 && (
        <TimelineSection title={t('eventMonitor.section.firedRecent').replace('{count}', String(fired.length))} subs={fired} />
      )}
      {subs.length === 0 && <div className="em-empty">{t('eventMonitor.emptySubscriptions')}</div>}
    </div>
  );
}
