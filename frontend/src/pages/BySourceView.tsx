/**
 * BySourceView sub-component for EventMonitor.
 * Extracted from EventMonitor.tsx (issue #448).
 */
import type { Subscription, AdapterStatus } from './eventMonitorUtils';
import { SOURCE_ICONS, getSubSource, formatDate } from './eventMonitorUtils';

export function BySourceView({ subs, adapters }: { subs: Subscription[]; adapters: AdapterStatus[] }) {
  const adapterMap = new Map(adapters.map(a => [a.name, a]));

  const bySource = subs.reduce<Record<string, Subscription[]>>((acc, s) => {
    const src = getSubSource(s.trigger);
    if (!acc[src]) acc[src] = [];
    acc[src].push(s);
    return acc;
  }, {});

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

        const nextFire = ssubs
          .filter(s => s.next_fire_at)
          .sort((a, b) => (a.next_fire_at ?? '').localeCompare(b.next_fire_at ?? ''))[0];

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
                {nextFire && (
                  <div className="em-source-detail">
                    <span>Ближайший огонь: <span>{formatDate(nextFire.next_fire_at)} ({nextFire.event_label ?? nextFire.event_id})</span></span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
