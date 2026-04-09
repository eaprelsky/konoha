/**
 * RunOverlay — case/run visualization on eEPC schema (closes #296)
 *
 * Shows the process diagram with color-coded status overlay:
 *   grey  = not_reached
 *   yellow/pulsing = running (current position)
 *   green = completed
 *   red   = error
 *
 * + Real-time event log + SSE updates from /cases/:id/stream
 */

import { useState, useEffect, useRef } from 'react';
import { EpcRenderer } from './EpcRenderer';
import { api } from '../api/client';
import type { Run, Workflow, HistoryEntry } from '../api/types';

const CSS = `
  .ro-backdrop { position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2000;display:flex;align-items:stretch;justify-content:flex-end; }
  .ro-panel { background:#fff;display:flex;flex-direction:column;width:min(1100px,97vw);height:100vh;box-shadow:-6px 0 32px rgba(0,0,0,.2); }

  .ro-header { display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid #e2e8f0;flex-shrink:0;background:#0f172a;color:#f8fafc; }
  .ro-title { flex:1;font-size:15px;font-weight:700; }
  .ro-badge { display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700;margin-left:6px; }
  .ro-badge.running  { background:#fef9c3;color:#b45309; }
  .ro-badge.done     { background:#dcfce7;color:#15803d; }
  .ro-badge.error    { background:#fee2e2;color:#dc2626; }
  .ro-close { background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;padding:0 4px;line-height:1; }
  .ro-close:hover { color:#f8fafc; }

  .ro-body { display:flex;flex:1;overflow:hidden; }

  /* Schema pane */
  .ro-schema { flex:1;overflow:auto;padding:20px;background:#f8fafc;display:flex;align-items:flex-start;justify-content:center; }

  /* Legend */
  .ro-legend { display:flex;gap:12px;padding:6px 20px;border-bottom:1px solid #e2e8f0;font-size:11px;flex-shrink:0;background:#fff;flex-wrap:wrap; }
  .ro-legend-item { display:flex;align-items:center;gap:5px; }
  .ro-dot { width:10px;height:10px;border-radius:2px;flex-shrink:0; }
  .ro-dot.not_reached { background:#d1d5db;opacity:.5; }
  .ro-dot.running  { background:#f59e0b; }
  .ro-dot.completed { background:#22c55e; }
  .ro-dot.error    { background:#ef4444; }

  /* Log pane */
  .ro-log { width:300px;flex-shrink:0;display:flex;flex-direction:column;border-left:1px solid #e2e8f0; }
  .ro-log-header { padding:10px 14px;font-size:12px;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0;background:#f8fafc;flex-shrink:0; }
  .ro-log-items { flex:1;overflow-y:auto;padding:8px 0; }
  .ro-log-item { padding:8px 14px;border-bottom:1px solid #f1f5f9;font-size:12px; }
  .ro-log-item:hover { background:#f8fafc; }
  .ro-log-label { font-weight:600;color:#1e293b;margin-bottom:2px; }
  .ro-log-meta { color:#94a3b8;font-size:11px;display:flex;gap:8px; }
  .ro-log-ts { font-family:monospace; }
  .ro-live-dot { display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-right:6px;animation:ro-pulse 1.2s ease-in-out infinite; }
  @keyframes ro-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.8)} }
  .ro-empty { text-align:center;color:#94a3b8;font-size:12px;padding:24px; }

  .ro-footer { padding:10px 20px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;background:#f8fafc;flex-shrink:0;display:flex;gap:16px;align-items:center; }
`;

function fmtTime(ts: string): string {
  try { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return ts; }
}

function fmtDelay(ts: string, prev: string | null): string {
  if (!prev) return '';
  const ms = new Date(ts).getTime() - new Date(prev).getTime();
  if (ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

interface RunOverlayProps {
  caseId: string;
  onClose: () => void;
}

export function RunOverlay({ caseId, onClose }: RunOverlayProps) {
  const [run, setRun] = useState<Run | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const esRef = useRef<EventSource | null>(null);
  const logBottomRef = useRef<HTMLDivElement>(null);

  // Load initial case + workflow
  useEffect(() => {
    async function load() {
      try {
        const c = await api.cases.get(caseId);
        setRun(c);
        const wf = await api.workflows.get(c.process_id);
        setWorkflow(wf);
      } catch (e: any) {
        console.error('RunOverlay load:', e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [caseId]);

  // SSE stream for real-time updates
  useEffect(() => {
    const es = new EventSource(`/api/cases/${caseId}/stream`);
    esRef.current = es;
    setLive(true);

    es.addEventListener('update', (e: MessageEvent) => {
      try {
        const updated: Run = JSON.parse(e.data);
        setRun(updated);
        setLastUpdate(new Date().toLocaleTimeString());
      } catch {}
    });

    es.addEventListener('snapshot', (e: MessageEvent) => {
      try {
        const snap: Run = JSON.parse(e.data);
        setRun(snap);
      } catch {}
    });

    es.addEventListener('done', () => {
      setLive(false);
      es.close();
    });

    es.addEventListener('error', () => {
      setLive(false);
    });

    return () => { es.close(); esRef.current = null; };
  }, [caseId]);

  // Auto-scroll log
  useEffect(() => {
    logBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [run?.history?.length]);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const history: HistoryEntry[] = run?.history ?? [];

  return (
    <>
      <style>{CSS}</style>
      <div className="ro-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="ro-panel">
          {/* Header */}
          <div className="ro-header">
            <div className="ro-title">
              🔄 Прогон: {run?.subject ?? caseId}
              {run && (
                <span className={`ro-badge ${run.status}`}>
                  {run.status === 'running' ? 'В работе' : run.status === 'done' ? 'Завершён' : 'Ошибка'}
                </span>
              )}
            </div>
            {live && <span><span className="ro-live-dot" />live</span>}
            <button className="ro-close" onClick={onClose} title="Закрыть (Esc)">✕</button>
          </div>

          {/* Legend */}
          <div className="ro-legend">
            <div className="ro-legend-item"><div className="ro-dot not_reached" />Не начата</div>
            <div className="ro-legend-item"><div className="ro-dot running" />В работе</div>
            <div className="ro-legend-item"><div className="ro-dot completed" />Завершена</div>
            <div className="ro-legend-item"><div className="ro-dot error" />Ошибка</div>
          </div>

          <div className="ro-body">
            {/* Schema pane */}
            <div className="ro-schema">
              {loading && <div className="ro-empty">Загрузка…</div>}
              {!loading && (!workflow || !run) && (
                <div className="ro-empty">Не удалось загрузить схему</div>
              )}
              {workflow && run && (
                <EpcRenderer workflow={workflow} caseData={run} />
              )}
            </div>

            {/* Event log */}
            <div className="ro-log">
              <div className="ro-log-header">
                Хронология событий ({history.length})
              </div>
              <div className="ro-log-items">
                {history.length === 0 && (
                  <div className="ro-empty">Событий ещё нет</div>
                )}
                {history.map((h, i) => (
                  <div key={i} className="ro-log-item">
                    <div className="ro-log-label">{h.label}</div>
                    <div className="ro-log-meta">
                      <span className="ro-log-ts">{fmtTime(h.timestamp)}</span>
                      {i > 0 && <span>+{fmtDelay(h.timestamp, history[i - 1].timestamp)}</span>}
                      {h.element_type && <span style={{ color: '#c4b5fd' }}>{h.element_type}</span>}
                    </div>
                  </div>
                ))}
                <div ref={logBottomRef} />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="ro-footer">
            <span>Прогон: <code>{caseId.slice(0, 12)}…</code></span>
            {run?.current_step_label && <span>Шаг: <b>{run.current_step_label}</b></span>}
            {lastUpdate && <span>Обновлено: {lastUpdate}</span>}
            {run?.elapsed_ms !== undefined && (
              <span>Время: {run.elapsed_ms < 60000 ? `${(run.elapsed_ms / 1000).toFixed(1)}s` : `${Math.round(run.elapsed_ms / 60000)}m`}</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
