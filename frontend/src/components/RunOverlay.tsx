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
import { useI18n } from '../context/I18nContext';
import type { Run, Workflow, HistoryEntry } from '../api/types';
import { buildRoleLabelMap } from '../utils/agentDisplay';
import './RunOverlay.css';


function fmtTime(ts: string, lang: string): string {
  try { return new Date(ts).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
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
  const { lang, t } = useI18n();
  const [run, setRun] = useState<Run | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [wfError, setWfError] = useState(false);
  const [roleLabels, setRoleLabels] = useState<Record<string, string>>({});
  const [live, setLive] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const esRef = useRef<EventSource | null>(null);
  const logBottomRef = useRef<HTMLDivElement>(null);

  // Load case and workflow independently so history shows even if schema is gone
  useEffect(() => {
    async function load() {
      try {
        const c = await api.cases.get(caseId);
        setRun(c);
        setLoading(false);
        // Load workflow separately — failure here doesn't block case display
        api.workflows.get(c.process_id)
          .then(setWorkflow)
          .catch(() => setWfError(true));
      } catch (e: any) {
        console.error('RunOverlay load case:', e.message);
        setLoading(false);
      }
    }
    load();
  }, [caseId]);

  useEffect(() => {
    api.roles.list()
      .then(roles => setRoleLabels(buildRoleLabelMap(roles)))
      .catch(() => {});
  }, []);

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
      <div className="ro-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="ro-panel">
          {/* Header */}
          <div className="ro-header">
            <div className="ro-title">
              🔄 {t('label.run')}: {run?.subject ?? caseId}
              {run && (
                <span className={`ro-badge ${run.status}`}>
                  {run.status === 'running' ? t('status.running') : run.status === 'done' ? t('status.done') : t('status.error')}
                </span>
              )}
            </div>
            {live && <span><span className="ro-live-dot" />{t('runOverlay.live')}</span>}
            <button className="ro-close" onClick={onClose} title={t('runOverlay.closeEsc')}>✕</button>
          </div>

          {/* Legend */}
          <div className="ro-legend">
            <div className="ro-legend-item"><div className="ro-dot not_reached" />{t('runOverlay.notReached')}</div>
            <div className="ro-legend-item"><div className="ro-dot running" />{t('status.running')}</div>
            <div className="ro-legend-item"><div className="ro-dot completed" />{t('runOverlay.completed')}</div>
            <div className="ro-legend-item"><div className="ro-dot error" />{t('status.error')}</div>
          </div>

          <div className="ro-body">
            {/* Schema pane */}
            <div className="ro-schema">
              {loading && <div className="ro-empty">{t('status.loading')}</div>}
              {!loading && !run && (
                <div className="ro-empty">{t('runOverlay.runNotFound')}</div>
              )}
              {!loading && run && !workflow && !wfError && (
                <div className="ro-empty">{t('runOverlay.loadingSchema')}</div>
              )}
              {!loading && run && wfError && (
                <div className="ro-empty" style={{ color: '#f59e0b' }}>
                  {t('runOverlay.schemaUnavailable')}
                </div>
              )}
              {workflow && run && (
                <EpcRenderer workflow={workflow} caseData={run} roleLabels={roleLabels} />
              )}
            </div>

            {/* Event log */}
            <div className="ro-log">
              <div className="ro-log-header">
                {t('runOverlay.timeline').replace('{count}', String(history.length))}
              </div>
              <div className="ro-log-items">
                {history.length === 0 && (
                  <div className="ro-empty">{t('runOverlay.noEvents')}</div>
                )}
                {history.map((h, i) => (
                  <div key={i} className="ro-log-item">
                    <div className="ro-log-label">{h.label}</div>
                    <div className="ro-log-meta">
                      <span className="ro-log-ts">{fmtTime(h.timestamp, lang)}</span>
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
            <span>{t('label.run')}: <code>{caseId.slice(0, 12)}…</code></span>
            {run?.current_step_label && <span>{t('label.step')}: <b>{run.current_step_label}</b></span>}
            {lastUpdate && <span>{t('runOverlay.updated')}: {lastUpdate}</span>}
            {run?.elapsed_ms !== undefined && (
              <span>{t('runOverlay.elapsed')}: {run.elapsed_ms < 60000 ? `${(run.elapsed_ms / 1000).toFixed(1)}s` : `${Math.round(run.elapsed_ms / 60000)}m`}</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
