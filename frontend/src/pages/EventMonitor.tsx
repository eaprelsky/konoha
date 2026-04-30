/**
 * EventMonitor page — event subscriptions timeline and adapter status.
 *
 * Decomposed (issue #448):
 *  - eventMonitorUtils.ts  — types, constants, helpers, CSS
 *  - EventCard.tsx         — TriggerDetails + EventCard components
 *  - TimelineView.tsx      — TimelineSection + TimelineView
 *  - ByProcessView.tsx     — ByProcessView
 *  - BySourceView.tsx      — BySourceView
 *  - useEventMonitor.ts    — data fetching hook (filters, polling)
 */
import { useSetSubtitle } from '../context/SubtitleContext';
import { useI18n } from '../context/I18nContext';
import { eventMonitorStyles } from './eventMonitorUtils';
import type { Tab } from './eventMonitorUtils';
import { useEventMonitor } from '../hooks/useEventMonitor';
import { TimelineView } from './TimelineView';
import { ByProcessView } from './ByProcessView';
import { BySourceView } from './BySourceView';

export function EventMonitor() {
  const { t } = useI18n();
  const {
    subs, summary, adapters, loading, error, lastUpdate,
    tab, setTab,
    filterKind, setFilterKind,
    filterSource, setFilterSource,
    filterProcess, setFilterProcess,
    filterStatus, setFilterStatus,
    showHiddenArtifacts, setShowHiddenArtifacts, hiddenSubscriptionCount,
    processes, resetFilters, updateUrl,
  } = useEventMonitor();

  const badge = summary.errors + summary.manual_fallback;
  useSetSubtitle(badge > 0 ? t('eventMonitor.subtitleAttention').replace('{count}', String(badge)) : undefined);

  const tabs: [Tab, string][] = [
    ['timeline',   t('eventMonitor.tab.timeline')],
    ['by-process', t('eventMonitor.tab.byProcess')],
    ['by-source',  t('eventMonitor.tab.bySource')],
  ];

  const hasFilters = !!(filterKind || filterStatus || filterProcess || filterSource);

  return (
    <>
      <style>{eventMonitorStyles}</style>
      <div className="em-body">
        <div className="em-container">

          {/* Summary counters */}
          <div className="em-summary">
            <div className="em-counter info"><div className="val">{summary.total}</div><div className="lbl">{t('eventMonitor.total')}</div></div>
            <div className="em-counter ok"><div className="val">{summary.waiting}</div><div className="lbl">{t('eventMonitor.waiting')}</div></div>
            <div className="em-counter ok"><div className="val">{summary.fired_today}</div><div className="lbl">{t('eventMonitor.today')}</div></div>
            <div className="em-counter err"><div className="val">{summary.errors}</div><div className="lbl">{t('eventMonitor.errors')}</div></div>
            <div className="em-counter warn"><div className="val">{summary.manual_fallback}</div><div className="lbl">{t('eventMonitor.manual')}</div></div>
            <div className="em-refresh" style={{ marginLeft: 'auto' }}>
              <span className="em-refresh-dot" />
              {t('eventMonitor.updated').replace('{time}', lastUpdate || '—')}
            </div>
          </div>

          {error && <div className="em-error-banner">{t('eventMonitor.loadError').replace('{message}', error)}</div>}

          {/* Tabs */}
          <div className="em-tabs">
            {tabs.map(([t, label]) => (
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
              <option value="">{t('eventMonitor.allTypes')}</option>
              <option value="timer">Timer</option>
              <option value="delay_after">Delay After</option>
              <option value="message">Message</option>
              <option value="condition">Condition</option>
              <option value="manual">Manual</option>
              <option value="system">System</option>
            </select>
            <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); updateUrl({ status: e.target.value }); }}>
              <option value="">{t('eventMonitor.allStatuses')}</option>
              <option value="waiting">{t('operator.workitems.waiting')}</option>
              <option value="fired">{t('eventMonitor.statusFired')}</option>
              <option value="error">{t('run.status.error')}</option>
              <option value="manual_fallback">{t('eventMonitor.statusManualFallback')}</option>
            </select>
            <select value={filterProcess} onChange={e => { setFilterProcess(e.target.value); updateUrl({ process: e.target.value }); }}>
              <option value="">{t('eventMonitor.allProcesses')}</option>
              {processes.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filterSource} onChange={e => { setFilterSource(e.target.value); updateUrl({ source: e.target.value }); }}>
              <option value="">{t('eventMonitor.allSources')}</option>
              <option value="bitrix">{t('eventMonitor.sourceBitrix')}</option>
              <option value="telegram">{t('eventMonitor.sourceTelegram')}</option>
              <option value="tracker">{t('eventMonitor.sourceTracker')}</option>
            </select>
            {hiddenSubscriptionCount > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b' }} title={t('eventMonitor.hiddenTitle')}>
                <input
                  type="checkbox"
                  checked={showHiddenArtifacts}
                  onChange={e => setShowHiddenArtifacts(e.target.checked)}
                />
                {t('eventMonitor.hidden').replace('{count}', String(hiddenSubscriptionCount))}
              </label>
            )}
            {hasFilters && <button className="reset-btn" onClick={resetFilters}>{t('eventMonitor.reset')}</button>}
          </div>

          {/* Content */}
          {loading ? (
            <div className="em-loading">{t('eventMonitor.loading')}</div>
          ) : (
            <>
              {tab === 'timeline'   && <TimelineView subs={subs} />}
              {tab === 'by-process' && <ByProcessView subs={subs} />}
              {tab === 'by-source'  && <BySourceView subs={subs} adapters={adapters} />}
            </>
          )}
        </div>
      </div>
    </>
  );
}
