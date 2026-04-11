/**
 * ByProcessView sub-component for EventMonitor.
 * Extracted from EventMonitor.tsx (issue #448).
 */
import { useState } from 'react';
import type { Subscription } from './eventMonitorUtils';
import { STATUS_LABELS, STATUS_DOTS, formatDateShort } from './eventMonitorUtils';

export function ByProcessView({ subs }: { subs: Subscription[] }) {
  const [openProcesses, setOpenProcesses] = useState<Set<string>>(new Set());
  const [openInstances, setOpenInstances] = useState<Set<string>>(new Set());

  const byProcess = subs.reduce<Record<string, Subscription[]>>((acc, s) => {
    if (!acc[s.process_id]) acc[s.process_id] = [];
    acc[s.process_id].push(s);
    return acc;
  }, {});

  if (Object.keys(byProcess).length === 0) {
    return <div className="em-empty">Нет подписок</div>;
  }

  function toggleProcess(id: string) {
    setOpenProcesses(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleInstance(id: string) {
    setOpenInstances(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div>
      {Object.entries(byProcess).map(([processId, psubs]) => {
        const processOpen = openProcesses.has(processId);
        const processName = psubs[0]?.process_name ?? processId;
        const byInstance = psubs.reduce<Record<string, Subscription[]>>((acc, s) => {
          if (!acc[s.instance_id]) acc[s.instance_id] = [];
          acc[s.instance_id].push(s);
          return acc;
        }, {});

        return (
          <div key={processId} className="em-process-group">
            <div className="em-process-header" onClick={() => toggleProcess(processId)}>
              <span style={{ fontSize: 13 }}>{processOpen ? '▼' : '▶'}</span>
              <span className="em-process-name">{processName}</span>
              <span className="em-process-meta">
                {Object.keys(byInstance).length} экз. · {psubs.length} подп.
                {psubs.some(s => s.ui_status === 'error') && ' · ⚠ ошибки'}
              </span>
            </div>
            {processOpen && Object.entries(byInstance).map(([instanceId, isubs]) => {
              const instOpen = openInstances.has(instanceId);
              return (
                <div key={instanceId} className="em-instance-group">
                  <div className="em-instance-header" onClick={() => toggleInstance(instanceId)}>
                    <span style={{ fontSize: 12 }}>{instOpen ? '▼' : '▶'}</span>
                    <span className="em-instance-name">{instanceId}</span>
                    <span className="em-process-meta">{isubs.length} событий</span>
                  </div>
                  {instOpen && (
                    <div className="em-instance-events">
                      {isubs.map(s => (
                        <div key={s.id} className="em-tree-event">
                          <span className="em-tree-event-dot">{STATUS_DOTS[s.ui_status]}</span>
                          <span className="em-tree-event-label">{s.event_label ?? s.event_id}</span>
                          <span className={`em-status-badge ${s.ui_status}`} style={{ fontSize: 10 }}>
                            {STATUS_LABELS[s.ui_status]}
                          </span>
                          <span className="em-tree-event-time">
                            {s.next_fire_at ? formatDateShort(s.next_fire_at) : formatDateShort(s.last_fired_at)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
