import { useState, useEffect, useCallback } from 'react';
import { Layout } from '../components/Layout';
import { StatusBadge } from '../components/StatusBadge';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { WorkItem, WorkItemFilters, Case, Workflow } from '../api/types';

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

interface DetailsModalProps { item: WorkItem | null; onClose: () => void; }
function DetailsModal({ item, onClose }: DetailsModalProps) {
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
            <h2 id="detailsTitle">Details: {item.label}</h2>
            <div id="detailsContent">
              <div className="detail-field"><strong>ID</strong><code>{item.work_item_id}</code></div>
              {item.case_id && <div className="detail-field"><strong>Case ID</strong><code>{item.case_id}</code></div>}
              <div className="detail-field"><strong>Input</strong><code>{JSON.stringify(item.input || {}, null, 2)}</code></div>
              <div className="detail-field"><strong>Output</strong><code>{JSON.stringify(item.output || {}, null, 2)}</code></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function WorkItems() {
  const token = useToken();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>('-');
  const [filters, setFilters] = useState<WorkItemFilters>({});
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null);
  const [wfNameMap, setWfNameMap] = useState<Record<string, string>>({});
  const [caseCache, setCaseCache] = useState<Record<string, Case>>({});

  // Load workflow names once
  useEffect(() => {
    if (!token) return;
    api.workflows.list().then(wfs => {
      const m: Record<string, string> = {};
      wfs.forEach((wf: Workflow) => { m[wf.id] = wf.name || wf.id; });
      setWfNameMap(m);
    }).catch(() => {});
  }, [token]);

  const loadItems = useCallback(() => {
    if (!token) return;
    api.workitems.list(filters)
      .then(data => {
        setItems(data);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
        setLoading(false);
        // Fetch case data for step progress
        const newCaseIds = data.filter((i: WorkItem) => i.case_id && !caseCache[i.case_id!]).map((i: WorkItem) => i.case_id!);
        newCaseIds.forEach((caseId: string) => {
          api.cases.get(caseId).then(kase => {
            setCaseCache(prev => ({ ...prev, [caseId]: kase }));
          }).catch(() => {});
        });
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadItems(); }, [loadItems]);
  useInterval(loadItems, 10000);

  function completeItem(id: string) {
    if (!confirm('Mark this item as complete?')) return;
    api.workitems.complete(id)
      .then(() => loadItems())
      .catch(e => setError(`Failed to complete item: ${e.message}`));
  }

  const [localFilters, setLocalFilters] = useState<WorkItemFilters>({});

  return (
    <Layout activePage="workitems.html">
      <style>{styles}</style>
      <div className="wf-body">
        <div className="container">
          <h1>Work Items</h1>
          {error && <div className="error-banner">{error}</div>}

          <div className="filters">
            <div className="filter-group">
              <label htmlFor="filterAssignee">Assignee</label>
              <input id="filterAssignee" type="text" placeholder="Filter by assignee..."
                value={localFilters.assignee || ''}
                onChange={e => setLocalFilters(f => ({ ...f, assignee: e.target.value }))} />
            </div>
            <div className="filter-group">
              <label htmlFor="filterProcess">Process ID</label>
              <input id="filterProcess" type="text" placeholder="Filter by process..."
                value={localFilters.process_id || ''}
                onChange={e => setLocalFilters(f => ({ ...f, process_id: e.target.value }))} />
            </div>
            <div className="filter-group">
              <label htmlFor="filterStatus">Status</label>
              <select id="filterStatus" value={localFilters.status || ''}
                onChange={e => setLocalFilters(f => ({ ...f, status: e.target.value as any }))}>
                <option value="">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="assigned">Assigned</option>
                <option value="running">Running</option>
                <option value="done">Done</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div className="filter-group">
              <label htmlFor="filterDeadline">Deadline Before</label>
              <input id="filterDeadline" type="date"
                value={localFilters.deadline_before || ''}
                onChange={e => setLocalFilters(f => ({ ...f, deadline_before: e.target.value }))} />
            </div>
            <div className="button-group">
              <button onClick={() => setFilters(localFilters)}>Apply Filters</button>
              <button className="reset" onClick={() => { setLocalFilters({}); setFilters({}); }}>Reset</button>
            </div>
          </div>

          {loading && <div className="loading-msg">Loading...</div>}

          {!loading && items.length === 0 && !error && (
            <div className="empty">No work items found.</div>
          )}

          {items.length > 0 && (
            <table className="items-table" id="itemsTable">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Assignee</th>
                  <th>Status</th>
                  <th>Process / Case</th>
                  <th>Progress</th>
                  <th>Deadline</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="itemsBody">
                {items.map(item => {
                  const kase = item.case_id ? caseCache[item.case_id] : undefined;
                  const progress = kase ? getStepLabel(kase, item.work_item_id) : '-';
                  const processCell = formatProcessCase(item, wfNameMap);
                  const fullTitle = [item.process_id, item.case_id].filter(Boolean).join(' / ');
                  const deadline = item.deadline ? new Date(item.deadline).toLocaleDateString() : '-';
                  return (
                    <tr key={item.work_item_id}>
                      <td><span className="item-label">{item.label}</span></td>
                      <td>{item.assignee || '-'}</td>
                      <td><StatusBadge status={item.status} /></td>
                      <td>
                        {(item.process_id || item.case_id)
                          ? <span title={fullTitle} style={{ cursor: 'default' }}>{processCell}</span>
                          : '-'}
                      </td>
                      <td className="step-progress"
                          data-case-id={item.case_id || ''}
                          data-wi-id={item.work_item_id}>
                        {progress}
                      </td>
                      <td>{deadline}</td>
                      <td className="item-actions">
                        <button className="complete" onClick={() => completeItem(item.work_item_id)}>Complete</button>
                        <button onClick={() => setDetailItem(item)}>Details</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="refresh-info">
            Auto-refresh every 10 seconds • Last update: <span id="lastUpdate">{lastUpdate}</span>
          </div>
        </div>
      </div>

      <DetailsModal item={detailItem} onClose={() => setDetailItem(null)} />
    </Layout>
  );
}
