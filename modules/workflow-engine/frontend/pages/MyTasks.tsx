/**
 * MyTasks — personal inbox of the current user/agent.
 * Work items grouped by urgency: overdue / due soon / in progress.
 */
import { useState, useCallback, useEffect } from 'react';
import { useToken } from '@core/context/TokenContext';
import { useInterval } from '@core/hooks/useApi';
import { api } from '@core/api/client';
import type { WorkItem } from '@core/api/types';
import './MyTasks.css';

const lang = document.documentElement.lang || 'ru';

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function fmtDeadline(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  if (diff < 0) return lang === 'ru' ? 'Просрочено' : 'Overdue';
  const h = Math.floor(diff / 3_600_000);
  if (h < 24) return lang === 'ru' ? `через ${h}ч` : `in ${h}h`;
  return lang === 'ru' ? `через ${Math.floor(h / 24)}д` : `in ${Math.floor(h / 24)}d`;
}

type Urgency = 'overdue' | 'soon' | 'inProgress';

function urgencyOf(wi: WorkItem): Urgency {
  if (!wi.deadline) return 'inProgress';
  const diff = new Date(wi.deadline).getTime() - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 6 * 3_600_000) return 'soon';
  return 'inProgress';
}

const GROUP_META: Record<Urgency, { label: string; labelEn: string; color: string; bg: string }> = {
  overdue:    { label: 'Просрочено',     labelEn: 'Overdue',     color: '#ef4444', bg: '#fef2f2' },
  soon:       { label: 'Скоро дедлайн',  labelEn: 'Due soon',    color: '#f59e0b', bg: '#fffbeb' },
  inProgress: { label: 'В работе',       labelEn: 'In progress', color: '#3b82f6', bg: '#eff6ff' },
};


export function MyTasks() {
  const token = useToken();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [completing, setCompleting] = useState<Set<string>>(new Set());

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
  items.forEach(wi => groups[urgencyOf(wi)].push(wi));

  const isEmpty = items.length === 0 && !loading;

  return (
    <>
      <div className="mt-root">
        <div className="mt-header">
          <h1>{lang === 'ru' ? 'Мои задачи' : 'My Tasks'}</h1>
          <p>{lang === 'ru' ? 'Задачи, ожидающие вашего действия' : 'Tasks waiting for your action'}</p>
        </div>

        <div className="assignee-filter">
          <label>{lang === 'ru' ? 'Исполнитель' : 'Assignee'}</label>
          <input
            placeholder={lang === 'ru' ? 'Имя роли или агента…' : 'Role or agent name…'}
            value={assigneeFilter}
            onChange={e => setAssigneeFilter(e.target.value)}
          />
        </div>

        {error && <div className="mt-error">{error}</div>}

        {isEmpty && (
          <div className="mt-empty">
            <div className="icon">✓</div>
            <div>{lang === 'ru' ? 'Нет ожидающих задач' : 'No pending tasks'}</div>
          </div>
        )}

        {(['overdue', 'soon', 'inProgress'] as Urgency[]).map(g => {
          const gItems = groups[g];
          if (gItems.length === 0) return null;
          const meta = GROUP_META[g];
          return (
            <div key={g} className="mt-group">
              <div className="mt-group-title">
                <h2 style={{ color: meta.color }}>{lang === 'ru' ? meta.label : meta.labelEn}</h2>
                <span className="mt-group-count">{gItems.length}</span>
              </div>
              {gItems.map(wi => {
                const dl = fmtDeadline(wi.deadline);
                return (
                  <div key={wi.work_item_id} className={`mt-item ${g}`}>
                    <div className="mt-item-body">
                      <div className="mt-item-label">{wi.label}</div>
                      <div className="mt-item-meta">
                        <span>{lang === 'ru' ? 'Исполнитель: ' : 'Assignee: '}<b>{wi.assignee}</b></span>
                        {wi.process_id && (
                          <span>{lang === 'ru' ? 'Процесс: ' : 'Process: '}<b>{wi.process_id}</b></span>
                        )}
                        <span>{lang === 'ru' ? 'Создано: ' : 'Created: '}<b>{fmtTime(wi.created_at)}</b></span>
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
                          ? (lang === 'ru' ? 'Сохранение…' : 'Saving…')
                          : (lang === 'ru' ? 'Выполнено' : 'Done')}
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
