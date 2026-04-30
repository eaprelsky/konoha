/**
 * EventCard and TriggerDetails sub-components for EventMonitor.
 * Extracted from EventMonitor.tsx (issue #448).
 */
import { useState } from 'react';
import type { Subscription } from './eventMonitorUtils';
import { triggerIcon, formatDate, formatDateShort, STATUS_LABELS } from './eventMonitorUtils';
import { useI18n } from '../context/I18nContext';

function TriggerDetails({ trigger }: { trigger: Record<string, any> }) {
  const { t } = useI18n();
  const fields = Object.entries(trigger).filter(([k]) => k !== 'kind');
  return (
    <div className="em-detail-grid">
      <span className="key">{t('eventMonitor.card.type')}</span>
      <span className="val">{trigger.kind}</span>
      {fields.map(([k]) => (
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

export function EventCard({ sub, defaultOpen = false }: { sub: Subscription; defaultOpen?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="em-card">
      <div className="em-card-header" onClick={() => setOpen(o => !o)}>
        <span className="em-card-icon">{triggerIcon(sub.trigger)}</span>
        <span className="em-card-title">{sub.event_label ?? sub.event_id}</span>
        <span className={`em-status-badge ${sub.ui_status}`}>{t(STATUS_LABELS[sub.ui_status])}</span>
        {sub.ui_status === 'waiting' && sub.next_fire_at && (
          <span className="em-card-meta">{formatDateShort(sub.next_fire_at, t('eventMonitor.today'))}</span>
        )}
        {sub.ui_status === 'fired' && sub.last_fired_at && (
          <span className="em-card-meta">{formatDateShort(sub.last_fired_at, t('eventMonitor.today'))}</span>
        )}
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className="em-card-body">
          {sub.error && <div className="em-error-text">⚠ {sub.error}</div>}
          <TriggerDetails trigger={sub.trigger} />
          <div className="em-detail-grid" style={{ marginTop: 8 }}>
            {sub.fire_count !== undefined && <>
              <span className="key">{t('eventMonitor.card.fireCount')}</span>
              <span className="val">{sub.fire_count}</span>
            </>}
            {sub.next_fire_at && <>
              <span className="key">{t('eventMonitor.card.nextFire')}</span>
              <span className="val">{formatDate(sub.next_fire_at)}</span>
            </>}
            {sub.last_fired_at && <>
              <span className="key">{t('eventMonitor.card.lastFire')}</span>
              <span className="val">{formatDate(sub.last_fired_at)}</span>
            </>}
            {sub.last_poll_at && <>
              <span className="key">{t('eventMonitor.card.lastPoll')}</span>
              <span className="val">{formatDate(sub.last_poll_at)} ({t('eventMonitor.card.pollResult')} {String(sub.last_poll_result ?? '?')})</span>
            </>}
            <span className="key">{t('eventMonitor.card.subscribed')}</span>
            <span className="val">{formatDate(sub.subscribed_at)}</span>
            <span className="key">{t('eventMonitor.card.mode')}</span>
            <span className="val">{sub.mode}</span>
          </div>
          <div className="em-context">
            {t('eventMonitor.card.process')} <a href={`/ui/editor/${sub.process_id}`}>{sub.process_name ?? sub.process_id}</a>
            {' · '}
            {t('eventMonitor.card.instance')} <a href={`/ui/cases.html?id=${sub.instance_id}`}>{sub.instance_id}</a>
            {' · '}
            {t('eventMonitor.card.node')} {sub.event_id}
          </div>
        </div>
      )}
    </div>
  );
}
