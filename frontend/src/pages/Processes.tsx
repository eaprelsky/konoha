import { useState } from 'react';
import { Layout } from '../components/Layout';
import { EpcRenderer } from '../components/EpcRenderer';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import type { Workflow } from '../api/types';

const styles = `
  .layout { display: grid; grid-template-columns: 280px 1fr; gap: 0; height: calc(100vh - 100px); }
  .sidebar { background: #fff; border-right: 1px solid #e2e8f0; overflow-y: auto; padding: 16px; }
  .sidebar h2 { font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 12px; }
  .category { margin-bottom: 4px; }
  .category-label { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer; border-radius: 6px; font-size: 13px; font-weight: 600; color: #334155; user-select: none; }
  .category-label:hover { background: #f1f5f9; }
  .category-label .arrow { transition: transform .15s; font-size: 10px; color: #94a3b8; }
  .category-label.open .arrow { transform: rotate(90deg); }
  .category-items { display: none; padding-left: 16px; }
  .category-items.open { display: block; }
  .process-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; cursor: pointer; border-radius: 6px; font-size: 13px; color: #475569; }
  .process-item:hover { background: #f1f5f9; }
  .process-item.active { background: #eff6ff; color: #1d4ed8; font-weight: 500; }
  .main { overflow-y: auto; padding: 24px; }
  .main .placeholder { color: #94a3b8; font-size: 15px; padding-top: 60px; text-align: center; }
  .proc-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
  .proc-header h2 { font-size: 18px; font-weight: 700; }
  .proc-header .meta { font-size: 12px; color: #64748b; margin-top: 4px; }
  .diagram-box { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; overflow-x: auto; margin-bottom: 20px; }
  .diagram-box h3 { font-size: 13px; color: #64748b; margin-bottom: 12px; }
  .loading { color: #94a3b8; font-size: 14px; padding: 40px 0; text-align: center; }
  .error-msg { color: #ef4444; font-size: 13px; }
`;

function groupByCategory(wfs: Workflow[]) {
  const groups: Record<string, Workflow[]> = {};
  wfs.forEach(wf => {
    const cat = (wf as any).category || wf.id.split('/')[0] || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(wf);
  });
  return groups;
}

function CategoryNode({ cat, items, selectedId, onSelect }: { cat: string; items: Workflow[]; selectedId: string | null; onSelect: (wf: Workflow) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="category">
      <div className={`category-label${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)}>
        <span className="arrow">▶</span> {cat} <span style={{ color: '#94a3b8', fontSize: 11 }}>({items.length})</span>
      </div>
      {open && (
        <div className="category-items open">
          {items.map(wf => (
            <div key={wf.id} className={`process-item${selectedId === wf.id ? ' active' : ''}`} data-id={wf.id} onClick={() => onSelect(wf)}>
              <span>{wf.name || wf.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Processes() {
  const { data: workflows, loading, error } = useApi(() => api.workflows.list());
  const [selected, setSelected] = useState<Workflow | null>(null);

  const groups = workflows ? groupByCategory(workflows) : {};

  return (
    <Layout activePage="processes.html">
      <style>{styles}</style>
      <div className="layout">
        <div className="sidebar">
          <h2>Process Registry</h2>
          <div id="tree">
            {loading && <div className="loading">Loading…</div>}
            {error && <div className="error-msg">Failed to load: {error}</div>}
            {!loading && !error && Object.keys(groups).length === 0 && (
              <div style={{ color: '#94a3b8', fontSize: 13 }}>No workflows registered</div>
            )}
            {Object.entries(groups).map(([cat, items]) => (
              <CategoryNode key={cat} cat={cat} items={items} selectedId={selected?.id ?? null} onSelect={setSelected} />
            ))}
          </div>
        </div>
        <div className="main" id="main">
          {!selected ? (
            <div className="placeholder">← Select a process to view its diagram</div>
          ) : (
            <>
              <div className="proc-header">
                <div>
                  <h2>{selected.name || selected.id}</h2>
                  <div className="meta">ID: {selected.id} &nbsp;|&nbsp; v{(selected as any).version || '—'}</div>
                  {(selected as any).description && (
                    <div style={{ fontSize: 13, color: '#475569', marginTop: 6 }}>{(selected as any).description}</div>
                  )}
                </div>
              </div>
              <div className="diagram-box">
                <h3>eEPC Diagram</h3>
                <div id="diagram">
                  <EpcRenderer workflow={selected} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
