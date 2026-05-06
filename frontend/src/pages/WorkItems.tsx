import { useState, useEffect, useCallback, useMemo } from 'react';
import type React from 'react';
import { StatusBadge } from '../components/StatusBadge';
import { useToken } from '../context/TokenContext';
import { useI18n } from '../context/I18nContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { WorkItem, WorkItemFilters, PaginatedWorkItems, Case, Workflow, EventWait, EventWaitStatus, Agent, RoleDef } from '../api/types';
import { buildAgentLabelMap, buildRoleLabelMap, formatAssignee, type AssigneeOption } from '../utils/agentDisplay';
import { filterOperatorWaits, filterOperatorWorkItems, isWorkflowHiddenFromOperator, useOperatorViewMode } from '../utils/operatorView';

const styles = `
  .wf-body { padding: 20px; }
  .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .container h1 { margin-bottom: 20px; color: #333; font-size: 24px; }
  .filters { display: grid; grid-template-columns: repeat(auto-fit,minmax(200px,1fr)); gap: 12px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
  .filter-group { display: flex; flex-direction: column; }
  .filter-group label { font-size: 12px; font-weight: 600; color: #666; margin-bottom: 4px; text-transform: uppercase; }
  .filter-group input, .filter-group select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .filter-group input:focus, .filter-group select:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,.1); }
  .button-group { display: flex; gap: 8px; align-items: flex-end; }
  .button-group button { padding: 8px 16px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .button-group button:hover { background: #0052a3; }
  .button-group .reset { background: #999; }
  .button-group .reset:hover { background: #777; }
  .hidden-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #64748b; }
  .items-table { width: 100%; border-collapse: collapse; }
  .items-table th { background: #f9f9f9; padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .items-table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  .items-table tr:hover { background: #fafafa; }
  .item-label { font-weight: 600; color: #333; }
  .item-link { color: #0066cc; text-decoration: none; }
  .item-link:hover { text-decoration: underline; }
  .item-actions { display: flex; gap: 6px; }
  .item-actions button { padding: 6px 10px; border: 1px solid #ddd; background: white; color: #333; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .item-actions button:hover { background: #f0f0f0; }
  .item-actions button.complete { background: #10b981; color: white; border-color: #10b981; }
  .item-actions button.complete:hover { background: #059669; }
  .step-progress { font-size: 12px; color: #64748b; white-space: nowrap; }
  .loading-msg { text-align: center; padding: 40px; color: #666; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 20px; border-left: 4px solid #c33; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .details-modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; justify-content: center; align-items: center; }
  .details-modal.show { display: flex; }
  .modal-content { background: white; border-radius: 8px; padding: 20px; max-width: 500px; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 25px rgba(0,0,0,.15); position: relative; }
  .modal-content h2 { margin-bottom: 16px; color: #333; }
  .detail-field { margin-bottom: 12px; }
  .detail-field strong { display: block; font-size: 12px; color: #666; margin-bottom: 4px; text-transform: uppercase; }
  .detail-field code { display: block; background: #f5f5f5; padding: 8px; border-radius: 3px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .modal-close { position: absolute; top: 16px; right: 16px; background: none; border: none; font-size: 20px; cursor: pointer; color: #999; }
  .modal-close:hover { color: #333; }
  .refresh-info { font-size: 12px; color: #999; margin-top: 12px; text-align: right; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { margin-bottom: 0; }
  .page-subtitle { color: #64748b; font-size: 14px; margin-top: 4px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap: 12px; margin-bottom: 18px; }
  .summary-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; }
  .summary-card .summary-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #64748b; margin-bottom: 6px; }
  .summary-card .summary-value { font-size: 28px; font-weight: 700; color: #0f172a; }
  .summary-card.warn .summary-value { color: #d97706; }
  .summary-card.err .summary-value { color: #dc2626; }
  .summary-card.info .summary-value { color: #2563eb; }
  .section-card { margin-top: 18px; border-top: 1px solid #e5e7eb; padding-top: 18px; }
  .section-card h2 { font-size: 18px; color: #1f2937; margin-bottom: 4px; }
  .section-card p { color: #6b7280; font-size: 13px; margin-bottom: 12px; }
  .btn-new-task { padding: 8px 18px; background: #10b981; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn-new-task:hover { background: #059669; }
  .standalone-badge { display: inline-block; padding: 2px 7px; background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .new-task-form { display: flex; flex-direction: column; gap: 14px; }
  .new-task-form .form-group { display: flex; flex-direction: column; gap: 4px; }
  .new-task-form label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .new-task-form input, .new-task-form select { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .new-task-form input:focus, .new-task-form select:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,.1); }
  .new-task-form .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  .new-task-form .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .new-task-form .btn-submit { background: #10b981; color: white; }
  .new-task-form .btn-submit:hover { background: #059669; }
  .new-task-form .btn-cancel { background: #e5e7eb; color: #374151; }
  .new-task-form .btn-cancel:hover { background: #d1d5db; }
  @media (max-width: 768px) { .container { padding: 12px; } .filters { grid-template-columns: 1fr; } .items-table { font-size: 12px; } .items-table th, .items-table td { padding: 8px; } .item-actions { flex-direction: column; } .item-actions button { width: 100%; } }
`;

function formatProcessCase(item: WorkItem, wfNameMap: Record<string, string>): string {
  if (!item.process_id && !item.case_id) return '-';
  const name = wfNameMap[item.process_id || ''] ||
    (item.process_id ? item.process_id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');
  const shortCase = item.case_id ? item.case_id.substring(0, 6).toUpperCase() : '';
  return shortCase ? `${name} #${shortCase}` : name;
}

function getStepLabel(kase: Case, wiId: string): string {
  const idx = (kase.history || []).findIndex((h: any) => h.work_item_id === wiId);
  if (idx === -1) return '';
  return `step ${idx + 1}/${kase.history.length}`;
}

interface NewTaskModalProps { onClose: () => void; onCreated: () => void; assigneeOptions: AssigneeOption[]; workflows: Workflow[]; }
function NewTaskModal({ onClose, onCreated, assigneeOptions, workflows }: NewTaskModalProps) {
  const { t } = useI18n();
  const [label, setLabel] = useState('');
  const [assignee, setAssignee] = useState('');
  const [processId, setProcessId] = useState('');
  const [deadline, setDeadline] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !assignee.trim()) { setError(t('operator.workitems.labelRequired')); return; }
    setSubmitting(true);
    setError(null);
    try {
      await api.workitems.create({
        label: label.trim(),
        assignee: assignee.trim(),
        deadline: deadline || undefined,
        ...(processId ? { process_id: processId } : {}),
      });
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="details-modal show" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>{t('operator.workitems.newTaskTitle')}</h2>
        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
        <form className="new-task-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="ntLabel">{t('operator.workitems.descriptionRequired')}</label>
            <input id="ntLabel" type="text" placeholder={t('input.taskDescription')} value={label}
              onChange={e => setLabel(e.target.value)} autoFocus required />
          </div>
          <div className="form-group">
            <label htmlFor="ntAssignee">{t('operator.workitems.assigneeRequired')}</label>
            <select id="ntAssignee" value={assignee} onChange={e => setAssignee(e.target.value)} required>
              <option value="">{t('operator.workitems.selectAssignee')}</option>
              {assigneeOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="ntProcess">{t('operator.runs.process')}</label>
            <select id="ntProcess" value={processId} onChange={e => setProcessId(e.target.value)}>
              <option value="">{t('operator.workitems.noProcess')}</option>
              {workflows.map(wf => <option key={wf.id} value={wf.id}>{wf.name || wf.id}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="ntDeadline">{t('operator.workitems.dueDate')}</label>
            <input id="ntDeadline" type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel" onClick={onClose}>{t('action.cancel')}</button>
            <button type="submit" className="btn-submit" disabled={submitting}>
              {submitting ? t('operator.workitems.creating') : t('action.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DetailsModalProps { item: WorkItem | null; onClose: () => void; }
function DetailsModal({ item, onClose }: DetailsModalProps) {
  const { t } = useI18n();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className={`details-modal${item ? ' show' : ''}`} id="detailsModal">
      <div className="modal-content">
        <button className="modal-close" onClick={onClose}>✕</button>
        {item && (
          <>
            <h2 id="detailsTitle">{t('operator.workitems.detailTitle').replace('{label}', item.label)}</h2>
            <div id="detailsContent">
              <div className="detail-field"><strong>ID</strong><code>{item.work_item_id}</code></div>
              {item.case_id && <div className="detail-field"><strong>{t('operator.workitems.runId')}</strong><code>{item.case_id}</code></div>}
              <div className="detail-field"><strong>{t('operator.workitems.inputData')}</strong><code>{JSON.stringify(item.input || {}, null, 2)}</code></div>
              <div className="detail-field"><strong>{t('operator.workitems.outputData')}</strong><code>{JSON.stringify(item.output || {}, null, 2)}</code></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function WorkItems() {
  const token = useToken();
  const { t } = useI18n();
  const { showHiddenArtifacts, setShowHiddenArtifacts } = useOperatorViewMode();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [waits, setWaits] = useState<EventWait[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>('-');
  const [filters, setFilters] = useState<WorkItemFilters>({});
  const [waitStatusFilter, setWaitStatusFilter] = useState<EventWaitStatus | ''>('');
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [wfNameMap, setWfNameMap] = useState<Record<string, string>>({});
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [assigneeOptions, setAssigneeOptions] = useState<AssigneeOption[]>([]);
  const [agentLabels, setAgentLabels] = useState<Record<string, string>>({});
  const [roleLabels, setRoleLabels] = useState<Record<string, string>>({});
  const [caseCache, setCaseCache] = useState<Record<string, Case>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Load workflow names + agents + roles once
  useEffect(() => {
    if (!token) return;
    api.workflows.list().then(wfs => {
      const m: Record<string, string> = {};
      wfs.forEach((wf: Workflow) => { m[wf.id] = wf.name || wf.id; });
      setWfNameMap(m);
      setWorkflows(wfs);
    }).catch(() => {});
    Promise.all([
      api.agents.list().catch(() => [] as import('../api/types').Agent[]),
      api.roles.list().catch(() => [] as import('../api/types').RoleDef[]),
    ]).then(([agents, roles]) => {
      const nextAgentLabels = buildAgentLabelMap(agents as Agent[]);
      const nextRoleLabels = buildRoleLabelMap(roles as RoleDef[]);
      const opts = [
        ...(agents as Agent[]).map((a: Agent) => ({ value: a.id, label: nextAgentLabels[a.id] || a.id })),
        ...(roles as RoleDef[]).map((r: RoleDef) => ({
          value: r.role_id,
          label: r.assignees.length > 0
            ? `${r.name} -> ${r.assignees.map(id => nextAgentLabels[id] || id).join(', ')}`
            : r.name,
        })),
      ];
      setAgentLabels(nextAgentLabels);
      setRoleLabels(nextRoleLabels);
      setAssigneeOptions([...new Map(opts.map(opt => [opt.value, opt])).values()].sort((a, b) => a.label.localeCompare(b.label)));
    });
  }, [token]);

  const loadItems = useCallback(() => {
    if (!token) return;
    const paginatedFilters = { ...filters, offset: page * PAGE_SIZE, limit: PAGE_SIZE };
    Promise.all([
      api.workitems.list(paginatedFilters),
      api.waits.list({
        assignee: filters.assignee,
        process_id: filters.process_id,
        status: waitStatusFilter || undefined,
      }),
    ]).then(([workItemsData, waitsData]) => {
        const paged = workItemsData as PaginatedWorkItems;
        setItems(paged.items);
        setTotal(paged.total);
        setWaits(waitsData.waits);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
        setLoading(false);
        // Bound case enrichment — only for current page, max 20
        const unresolvedIds = new Set<string>();
        for (const i of paged.items) {
          if (i.case_id && !caseCache[i.case_id]) unresolvedIds.add(i.case_id);
          if (unresolvedIds.size >= 20) break;
        }
        for (const wait of waitsData.waits) {
          if (wait.case_id && !caseCache[wait.case_id]) unresolvedIds.add(wait.case_id);
          if (unresolvedIds.size >= 30) break;
        }
        unresolvedIds.forEach((caseId: string) => {
          api.cases.get(caseId).then(kase => {
            setCaseCache(prev => ({ ...prev, [caseId]: kase }));
          }).catch(() => {});
        });
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token, filters, waitStatusFilter, page]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadItems(); }, [loadItems]);
  useInterval(loadItems, 10000);

  function completeItem(id: string) {
    if (!confirm(t('operator.workitems.confirmComplete'))) return;
    api.workitems.complete(id)
      .then(() => loadItems())
      .catch(e => setError(t('operator.workitems.completeError').replace('{message}', e.message)));
  }

  function confirmWait(wait: EventWait) {
    if (!confirm(t('operator.workitems.confirmWait').replace('{label}', wait.element_label || wait.element_id))) return;
    api.waits.confirm(wait.wait_id, { confirmed_by: 'workbench' })
      .then(() => loadItems())
      .catch(e => setError(t('operator.workitems.confirmError').replace('{message}', e.message)));
  }

  const hiddenProcessIds = useMemo(
    () => new Set(workflows.filter(isWorkflowHiddenFromOperator).map(wf => wf.id)),
    [workflows],
  );
  const visibleItems = filterOperatorWorkItems(items, hiddenProcessIds, { showHiddenArtifacts });
  const visibleWaits = filterOperatorWaits(waits, hiddenProcessIds, { showHiddenArtifacts });
  const hiddenQueueCount =
    (items.length - filterOperatorWorkItems(items, hiddenProcessIds).length) +
    (waits.length - filterOperatorWaits(waits, hiddenProcessIds).length);
  const activeTasks = visibleItems.filter(item => item.status === 'pending' || item.status === 'running').length;
  const overdueWaits = visibleWaits.filter(wait => wait.status === 'overdue').length;
  const escalatedWaits = visibleWaits.filter(wait => wait.status === 'escalated').length;

  return (
    <>
      <style>{styles}</style>
      <div className="wf-body">
        <div className="container">
          <div className="page-header">
            <div>
              <h1>{t('operator.workitems.title')}</h1>
              <div className="page-subtitle">{t('operator.workitems.subtitle')}</div>
            </div>
            <button className="btn-new-task" onClick={() => setShowNewTask(true)}>{t('operator.workitems.newTask')}</button>
          </div>
          {error && <div className="error-banner">{error}</div>}

          <div className="summary-grid">
            <div className="summary-card info">
              <div className="summary-label">{t('operator.workitems.activeTasks')}</div>
              <div className="summary-value">{activeTasks}</div>
            </div>
            <div className="summary-card info">
              <div className="summary-label">{t('operator.workitems.activeWaits')}</div>
              <div className="summary-value">{visibleWaits.length}</div>
            </div>
            <div className={`summary-card${overdueWaits > 0 ? ' warn' : ''}`}>
              <div className="summary-label">{t('operator.workitems.overdueWaits')}</div>
              <div className="summary-value">{overdueWaits}</div>
            </div>
            <div className={`summary-card${escalatedWaits > 0 ? ' err' : ''}`}>
              <div className="summary-label">{t('operator.workitems.escalatedWaits')}</div>
              <div className="summary-value">{escalatedWaits}</div>
            </div>
          </div>

          <div className="filters">
            <div className="filter-group">
              <label htmlFor="filterAssignee">{t('operator.workitems.assignee')}</label>
              <select id="filterAssignee"
                value={filters.assignee || ''}
                onChange={e => { setFilters(f => ({ ...f, assignee: e.target.value || undefined })); setPage(0); }}>
                <option value="">{t('operator.workitems.allAssignees')}</option>
                {assigneeOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </div>
            <div className="filter-group">
              <label htmlFor="filterProcess">{t('operator.runs.process')}</label>
              <select id="filterProcess"
                value={filters.process_id || ''}
                onChange={e => { setFilters(f => ({ ...f, process_id: e.target.value || undefined })); setPage(0); }}>
                <option value="">{t('operator.workitems.allProcesses')}</option>
                {workflows.map(wf => (
                  <option key={wf.id} value={wf.id}>{wf.name || wf.id}</option>
                ))}
              </select>
            </div>
            <div className="filter-group">
              <label htmlFor="filterStatus">{t('operator.runs.status')}</label>
              <select id="filterStatus" value={filters.status || ''}
                onChange={e => { setFilters(f => ({ ...f, status: (e.target.value || undefined) as any })); setPage(0); }}>
                <option value="">{t('operator.workitems.allStatuses')}</option>
                <option value="pending">{t('operator.workitems.waiting')}</option>
                <option value="assigned">{t('operator.workitems.statusAssigned')}</option>
                <option value="running">{t('operator.runs.statusRunning')}</option>
                <option value="done">{t('operator.runs.statusDone')}</option>
                <option value="error">{t('operator.runs.statusError')}</option>
              </select>
            </div>
            <div className="filter-group">
              <label htmlFor="filterDeadline">{t('operator.workitems.deadlineBefore')}</label>
              <input id="filterDeadline" type="date"
                value={filters.deadline_before || ''}
                onChange={e => { setFilters(f => ({ ...f, deadline_before: e.target.value || undefined })); setPage(0); }} />
            </div>
            <div className="button-group">
              <button className="reset" onClick={() => { setFilters({}); setPage(0); }}>{t('action.reset')}</button>
            </div>
            {hiddenQueueCount > 0 && (
              <label className="hidden-toggle" title={t('operator.workitems.showHiddenTitle')}>
                <input
                  type="checkbox"
                  checked={showHiddenArtifacts}
                  onChange={e => setShowHiddenArtifacts(e.target.checked)}
                />
                {t('operator.workitems.showHidden').replace('{count}', String(hiddenQueueCount))}
              </label>
            )}
          </div>

          {loading && <div className="loading-msg">{t('operator.runs.loading')}</div>}

          {!loading && visibleItems.length === 0 && !error && (
            <div className="empty">{t('empty.workitems')}</div>
          )}

          {visibleItems.length > 0 && (
            <table className="items-table" id="itemsTable">
              <thead>
                <tr>
                  <th>{t('operator.workitems.description')}</th>
                  <th>{t('operator.workitems.assignee')}</th>
                  <th>{t('operator.runs.status')}</th>
                  <th>{t('operator.workitems.processRun')}</th>
                  <th>{t('operator.workitems.progress')}</th>
                  <th>{t('operator.workitems.deadline')}</th>
                  <th>{t('label.actions')}</th>
                </tr>
              </thead>
              <tbody id="itemsBody">
                {visibleItems.map(item => {
                  const kase = item.case_id ? caseCache[item.case_id] : undefined;
                  const progress = kase ? getStepLabel(kase, item.work_item_id) : '-';
                  const processCell = formatProcessCase(item, wfNameMap);
                  const fullTitle = [item.process_id, item.case_id].filter(Boolean).join(' / ');
                  const deadline = item.deadline ? new Date(item.deadline).toLocaleDateString() : '-';
                  const inputRole = typeof item.input?.role === 'string' ? item.input.role : undefined;
                  const assigneeLabel = formatAssignee(item.assignee, agentLabels, roleLabels, inputRole);
                  return (
                    <tr key={item.work_item_id}>
                      <td><span className="item-label">{item.label}</span></td>
                      <td title={item.assignee || ''}>{assigneeLabel}</td>
                      <td><StatusBadge status={item.status} /></td>
                      <td>
                        {(item.process_id || item.case_id)
                          ? <span title={fullTitle} style={{ cursor: 'default' }}>{processCell}</span>
                          : <span className="standalone-badge">{t('operator.workitems.standalone')}</span>}
                      </td>
                      <td className="step-progress"
                          data-case-id={item.case_id || ''}
                          data-wi-id={item.work_item_id}>
                        {progress}
                      </td>
                      <td>{deadline}</td>
                      <td className="item-actions">
                        <button className="complete" onClick={() => completeItem(item.work_item_id)}>{t('operator.workitems.complete')}</button>
                        <button onClick={() => setDetailItem(item)}>{t('operator.workitems.details')}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {total > PAGE_SIZE && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontSize: 13, color: '#64748b' }}>
              <span>{t('operator.workitems.showing')}: {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} {t('operator.workitems.of')} {total}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="reset"
                  style={{ padding: '4px 10px', fontSize: 12, background: '#e5e7eb', border: '1px solid #d1d5db', borderRadius: 4, cursor: page > 0 ? 'pointer' : 'default', opacity: page > 0 ? 1 : 0.5 }}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page <= 0}
                >{t('action.prev')}</button>
                <span style={{ padding: '4px 6px', fontWeight: 500 }}>{page + 1} / {Math.ceil(total / PAGE_SIZE)}</span>
                <button
                  className="reset"
                  style={{ padding: '4px 10px', fontSize: 12, background: '#e5e7eb', border: '1px solid #d1d5db', borderRadius: 4, cursor: (page + 1) * PAGE_SIZE < total ? 'pointer' : 'default', opacity: (page + 1) * PAGE_SIZE < total ? 1 : 0.5 }}
                  onClick={() => setPage(p => p + 1)}
                  disabled={(page + 1) * PAGE_SIZE >= total}
                >{t('action.next')}</button>
              </div>
            </div>
          )}
          <div className="refresh-info">
            {t('operator.workitems.refresh').replace('{time}', lastUpdate)}
          </div>

          <div className="section-card">
            <h2>{t('operator.workitems.waits')}</h2>
            <p>{t('operator.workitems.waitsSubtitle')}</p>
            <div className="filters" style={{ paddingBottom: 12, marginBottom: 12 }}>
              <div className="filter-group">
                <label htmlFor="waitStatus">{t('operator.workitems.waitStatus')}</label>
                <select id="waitStatus" value={waitStatusFilter} onChange={e => setWaitStatusFilter((e.target.value || '') as EventWaitStatus | '')}>
                  <option value="">{t('operator.workitems.activeProblemWaits')}</option>
                  <option value="active">{t('operator.workitems.waiting')}</option>
                  <option value="overdue">{t('operator.workitems.overdue')}</option>
                  <option value="escalated">{t('operator.workitems.escalated')}</option>
                </select>
              </div>
            </div>

            {!loading && visibleWaits.length === 0 && (
              <div className="empty">{t('operator.workitems.noActiveWaits')}</div>
            )}

            {visibleWaits.length > 0 && (
              <table className="items-table">
                <thead>
                  <tr>
                    <th>{t('operator.workitems.wait')}</th>
                    <th>{t('operator.workitems.type')}</th>
                    <th>{t('operator.runs.status')}</th>
                    <th>{t('operator.workitems.assignee')}</th>
                    <th>{t('operator.workitems.processRun')}</th>
                    <th>{t('operator.workitems.deadline')}</th>
                    <th>{t('label.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleWaits.map(wait => {
                    const processCell = formatProcessCase({
                      work_item_id: wait.wait_id,
                      case_id: wait.case_id,
                      process_id: wait.process_id,
                      element_id: wait.element_id,
                      label: wait.element_label || wait.element_id,
                      assignee: wait.assignee || '-',
                      status: 'pending',
                      input: {},
                      created_at: wait.created_at,
                      updated_at: wait.created_at,
                    }, wfNameMap);
                    return (
                      <tr key={wait.wait_id}>
                        <td>
                          <span className="item-label">{wait.element_label || wait.element_id}</span>
                          <div className="step-progress">{wait.wait_id.slice(0, 8)}</div>
                        </td>
                        <td>{wait.trigger_kind}</td>
                        <td><StatusBadge status={wait.status} /></td>
                        <td title={wait.assignee || ''}>{formatAssignee(wait.assignee, agentLabels, roleLabels)}</td>
                        <td>{processCell}</td>
                        <td>{wait.deadline ? new Date(wait.deadline).toLocaleString() : '-'}</td>
                        <td className="item-actions">
                          {wait.trigger_kind === 'manual' && (
                            <button className="complete" onClick={() => confirmWait(wait)}>{t('operator.workitems.complete')}</button>
                          )}
                          <button onClick={() => wait.case_id && api.cases.get(wait.case_id).then(kase => setCaseCache(prev => ({ ...prev, [wait.case_id]: kase }))).catch(() => {})}>{t('operator.workitems.updateRun')}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {showNewTask && <NewTaskModal onClose={() => setShowNewTask(false)} onCreated={loadItems} assigneeOptions={assigneeOptions} workflows={workflows} />}
      <DetailsModal item={detailItem} onClose={() => setDetailItem(null)} />
    </>
  );
}
