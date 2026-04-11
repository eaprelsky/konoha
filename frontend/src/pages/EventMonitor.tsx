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
  const { lang } = useI18n();
  const {
    subs, summary, adapters, loading, error, lastUpdate,
    tab, setTab,
    filterKind, setFilterKind,
    filterSource, setFilterSource,
    filterProcess, setFilterProcess,
    filterStatus, setFilterStatus,
    processes, resetFilters, updateUrl,
  } = useEventMonitor();

  const badge = summary.errors + summary.manual_fallback;
  useSetSubtitle(badge > 0 ? `${badge} требуют внимания` : undefined);

  const tabs: [Tab, string][] = [
    ['timeline',   lang === 'ru' ? 'Лента'        : 'Timeline'],
    ['by-process', lang === 'ru' ? 'По процессу'  : 'By Process'],
    ['by-source',  lang === 'ru' ? 'По источнику' : 'By Source'],
  ];

  const hasFilters = !!(filterKind || filterStatus || filterProcess || filterSource);

  return (
    <>
      <style>{eventMonitorStyles}</style>
      <div className="em-body">
        <div className="em-container">

          {/* Summary counters */}
          <div className="em-summary">
            <div className="em-counter info"><div className="val">{summary.total}</div><div className="lbl">Всего</div></div>
            <div className="em-counter ok"><div className="val">{summary.waiting}</div><div className="lbl">Ожидают</div></div>
            <div className="em-counter ok"><div className="val">{summary.fired_today}</div><div className="lbl">Сегодня</div></div>
            <div className="em-counter err"><div className="val">{summary.errors}</div><div className="lbl">Ошибки</div></div>
            <div className="em-counter warn"><div className="val">{summary.manual_fallback}</div><div className="lbl">Вручную</div></div>
            <div className="em-refresh" style={{ marginLeft: 'auto' }}>
              <span className="em-refresh-dot" />
              Обновлено: {lastUpdate || '—'} (30s)
            </div>
          </div>

          {error && <div className="em-error-banner">Ошибка загрузки: {error}</div>}

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
            {hasFilters && <button className="reset-btn" onClick={resetFilters}>Сбросить</button>}
          </div>

          {/* Content */}
          {loading ? (
            <div className="em-loading">Загрузка...</div>
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
