/**
 * MyTasks — personal inbox of the current user/agent.
 * Work items grouped by urgency: overdue / due soon / in progress.
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useToken } from '../context/TokenContext';
import { useI18n } from '../context/I18nContext';
import type { Lang } from '../i18n/translations';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { WorkItem, Workflow } from '../api/types';
import { filterOperatorWorkItems, isWorkflowHiddenFromOperator, useOperatorViewMode } from '../utils/operatorView';
import './MyTasks.css';

function fmtTime(iso: string, lang: Lang): string {
  try { return new Date(iso).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function fmtDeadline(iso: string | undefined, lang: Lang, t: (key: string, fallback?: string) => string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  if (diff < 0) return t('tasks.overdue');
  const h = Math.floor(diff / 3_600_000);
  if (h < 24) return t('tasks.deadlineHours').replace('{hours}', String(h));
  return t('tasks.deadlineDays').replace('{days}', String(Math.floor(h / 24)));
}

type Urgency = 'overdue' | 'soon' | 'inProgress';

function urgencyOf(wi: WorkItem): Urgency {
  if (!wi.deadline) return 'inProgress';
  const diff = new Date(wi.deadline).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 6 * 3_600_000) return 'soon';
  return 'inProgress';
}

const GROUP_META: Record<Urgency, { labelKey: string; color: string; bg: string }> = {
  overdue:    { labelKey: 'tasks.overdue',    color: '#ef4444', bg: '#fef2f2' },
  soon:       { labelKey: 'tasks.soon',       color: '#f59e0b', bg: '#fffbeb' },
  inProgress: { labelKey: 'tasks.inProgress', color: '#3b82f6', bg: '#eff6ff' },
};


export function MyTasks() {
  const token = useToken();
  const { lang, t } = useI18n();
  const { showHiddenArtifacts, setShowHiddenArtifacts } = useOperatorViewMode();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [completing, setCompleting] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!token) return;
    api.workflows.list()
      .then(data => setWorkflows(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [token]);

  const load = useCallback(() => {
    if (!token) return;
    const filters: Record<string, string> = { status: 'pending' };
    if (assigneeFilter.trim()) filters.assignee = assigneeFilter.trim();
    api.workitems.list(filters as any)
      .then(data => { setItems(Array.isArray(data) ? data : []); setLoading(false); setError(null); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token, assigneeFilter]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 15000);

  async function complete(wi: WorkItem) {
    setCompleting(prev => new Set([...prev, wi.work_item_id]));
    try {
      await api.workitems.complete(wi.work_item_id);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCompleting(prev => { const s = new Set(prev); s.delete(wi.work_item_id); return s; });
    }
  }

  // Group by urgency
  const groups: Record<Urgency, WorkItem[]> = { overdue: [], soon: [], inProgress: [] };
  const hiddenProcessIds = useMemo(
    () => new Set(workflows.filter(isWorkflowHiddenFromOperator).map(wf => wf.id)),
    [workflows],
  );
  const visibleItems = filterOperatorWorkItems(items, hiddenProcessIds, { showHiddenArtifacts });
  const hiddenItemCount = items.length - filterOperatorWorkItems(items, hiddenProcessIds).length;
  visibleItems.forEach(wi => groups[urgencyOf(wi)].push(wi));

  const isEmpty = visibleItems.length === 0 && !loading;

  return (
    <>
      <div className="mt-root">
        <div className="mt-header">
          <h1>{t('page.myTasks.title')}</h1>
          <p>{t('tasks.subtitle')}</p>
        </div>

        <div className="assignee-filter">
          <label>{t('label.assignee')}</label>
          <input
            placeholder={t('tasks.assigneePlaceholder')}
            value={assigneeFilter}
            onChange={e => setAssigneeFilter(e.target.value)}
          />
          {hiddenItemCount > 0 && (
            <label className="hidden-toggle" title={t('tasks.hiddenToggleTitle')}>
              <input
                type="checkbox"
                checked={showHiddenArtifacts}
                onChange={e => setShowHiddenArtifacts(e.target.checked)}
              />
              {t('operator.monitor.hidden').replace('{count}', String(hiddenItemCount))}
            </label>
          )}
        </div>

        {error && <div className="mt-error">{error}</div>}

        {isEmpty && (
          <div className="mt-empty">
            <div className="icon">✓</div>
            <div>{t('empty.myTasks')}</div>
          </div>
        )}

        {(['overdue', 'soon', 'inProgress'] as Urgency[]).map(g => {
          const gItems = groups[g];
          if (gItems.length === 0) return null;
          const meta = GROUP_META[g];
          return (
            <div key={g} className="mt-group">
              <div className="mt-group-title">
                <h2 style={{ color: meta.color }}>{t(meta.labelKey)}</h2>
                <span className="mt-group-count">{gItems.length}</span>
              </div>
              {gItems.map(wi => {
                const dl = fmtDeadline(wi.deadline, lang, t);
                return (
                  <div key={wi.work_item_id} className={`mt-item ${g}`}>
                    <div className="mt-item-body">
                      <div className="mt-item-label">{wi.label}</div>
                      <div className="mt-item-meta">
                        <span>{t('tasks.assigneePrefix')} <b>{wi.assignee}</b></span>
                        {wi.process_id && (
                          <span>{t('tasks.processPrefix')} <b>{wi.process_id}</b></span>
                        )}
                        <span>{t('tasks.createdPrefix')} <b>{fmtTime(wi.created_at, lang)}</b></span>
                      </div>
                    </div>
                    <div className="mt-item-actions">
                      {dl && <span className={`deadline-badge ${g}`}>{dl}</span>}
                      <button
                        className="btn-complete"
                        disabled={completing.has(wi.work_item_id)}
                        onClick={() => complete(wi)}
                      >
                        {completing.has(wi.work_item_id)
                          ? t('status.saving')
                          : t('status.done')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}
