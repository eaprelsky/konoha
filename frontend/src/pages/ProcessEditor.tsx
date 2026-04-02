/**
 * ProcessEditor — form-based eEPC process editor (#158)
 * Allows creating/editing processes: add elements, define flow connections,
 * preview diagram live via EpcRenderer.
 */
import { useState, useCallback, useEffect } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { EpcRenderer } from '../components/EpcRenderer';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';
import type { Workflow, WorkflowElement } from '../api/types';

type ElementType = WorkflowElement['type'];
const ELEMENT_TYPES: { value: ElementType; label: string; color: string }[] = [
  { value: 'event',              label: 'Event',            color: '#F5C4B3' },
  { value: 'function',           label: 'Function',         color: '#C0DD97' },
  { value: 'gateway',            label: 'Gateway',          color: '#E8F4FD' },
  { value: 'role',               label: 'Role (side)',      color: '#FFF9C4' },
  { value: 'document',           label: 'Document (side)',  color: '#DBEAFE' },
  { value: 'information_system', label: 'IS (side)',        color: '#E0F2FE' },
];

const styles = `
  .pe-body { padding: 0; display: flex; flex-direction: column; height: calc(100vh - 100px); }
  .pe-toolbar { background: #1e293b; color: white; padding: 10px 20px; display: flex; gap: 12px; align-items: center; flex-shrink: 0; }
  .pe-toolbar select, .pe-toolbar input { padding: 6px 10px; border: 1px solid #475569; background: #0f172a; color: white; border-radius: 4px; font-size: 13px; }
  .pe-toolbar select option { background: #1e293b; }
  .pe-toolbar button { padding: 6px 14px; border: 1px solid #475569; background: #334155; color: white; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; }
  .pe-toolbar button:hover { background: #475569; }
  .pe-toolbar button.btn-save { background: #16a34a; border-color: #16a34a; }
  .pe-toolbar button.btn-save:hover { background: #15803d; }
  .pe-toolbar button.btn-del { background: #dc2626; border-color: #dc2626; }
  .pe-toolbar .sep { width: 1px; background: #475569; height: 24px; }
  .pe-toolbar .wf-name { font-weight: 600; font-size: 14px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pe-main { display: flex; flex: 1; overflow: hidden; }
  .pe-sidebar { width: 320px; background: #fff; border-right: 1px solid #e2e8f0; overflow-y: auto; padding: 16px; flex-shrink: 0; }
  .pe-sidebar h3 { font-size: 13px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #eee; }
  .element-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }
  .element-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid #e2e8f0; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .element-item:hover { background: #f8fafc; }
  .element-item.selected { background: #eff6ff; border-color: #bfdbfe; }
  .element-dot { width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; }
  .element-id { font-family: monospace; font-size: 11px; color: #94a3b8; }
  .element-del { margin-left: auto; background: none; border: none; color: #ef4444; cursor: pointer; font-size: 14px; padding: 0 2px; }
  .form-group { margin-bottom: 12px; }
  .form-group label { display: block; font-size: 11px; font-weight: 600; color: #666; text-transform: uppercase; margin-bottom: 4px; }
  .form-group input, .form-group select { width: 100%; padding: 7px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; font-family: inherit; box-sizing: border-box; }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: #0066cc; }
  .btn-add { width: 100%; padding: 7px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; margin-top: 4px; }
  .flow-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px; font-size: 12px; border: 1px solid #e2e8f0; border-radius: 4px; }
  .flow-item .arrow { color: #9ca3af; }
  .flow-del { margin-left: auto; background: none; border: none; color: #ef4444; cursor: pointer; font-size: 14px; }
  .pe-canvas { flex: 1; overflow: auto; padding: 24px; background: #f8fafc; }
  .pe-canvas .preview-box { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; min-height: 200px; }
  .pe-canvas .empty-hint { color: #94a3b8; text-align: center; padding: 60px 20px; font-size: 14px; }
  .error-banner { background: #fee; color: #c33; padding: 8px 12px; border-radius: 4px; margin-bottom: 10px; font-size: 12px; border-left: 3px solid #c33; }
  .load-select { display: flex; gap: 8px; margin-bottom: 16px; }
  .load-select select { flex: 1; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
  .load-select button { padding: 6px 12px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
`;

function genId(type: ElementType, existing: WorkflowElement[]): string {
  const prefix = type.replace('_', '-');
  const nums = existing.filter(e => e.id.startsWith(prefix)).map(e => parseInt(e.id.split('-').pop() || '0', 10));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${next}`;
}

export function ProcessEditor() {
  const token = useToken();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWfId, setSelectedWfId] = useState('');
  const [elements, setElements] = useState<WorkflowElement[]>([]);
  const [flow, setFlow] = useState<[string, string, string?][]>([]);
  const [wfName, setWfName] = useState('');
  const [wfId, setWfId] = useState('');
  const [selectedEl, setSelectedEl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // New element form
  const [newType, setNewType] = useState<ElementType>('function');
  const [newLabel, setNewLabel] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newOperator, setNewOperator] = useState('AND');
  // New flow form
  const [flowFrom, setFlowFrom] = useState('');
  const [flowTo, setFlowTo] = useState('');

  const loadWorkflows = useCallback(() => {
    if (!token) return;
    api.workflows.list().then(setWorkflows).catch(() => {});
  }, [token]);

  useEffect(() => { loadWorkflows(); }, [loadWorkflows]);

  function loadWorkflow(id: string) {
    const wf = workflows.find(w => w.id === id);
    if (!wf) return;
    setWfId(wf.id); setWfName(wf.name || wf.id);
    setElements([...wf.elements]);
    setFlow([...(wf.flow || [])]);
    setSelectedEl(null); setError(null);
  }

  function addElement(e: React.FormEvent) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    const id = genId(newType, elements);
    const el: WorkflowElement = { id, type: newType, label: newLabel.trim() };
    if (newType === 'function' && newRole) el.role = newRole;
    if (newType === 'gateway') el.operator = newOperator;
    setElements(prev => [...prev, el]);
    setNewLabel(''); setNewRole('');
  }

  function removeElement(id: string) {
    setElements(prev => prev.filter(e => e.id !== id));
    setFlow(prev => prev.filter(([f, t]) => f !== id && t !== id));
    if (selectedEl === id) setSelectedEl(null);
  }

  function addFlow(e: React.FormEvent) {
    e.preventDefault();
    if (!flowFrom || !flowTo || flowFrom === flowTo) return;
    if (flow.some(([f, t]) => f === flowFrom && t === flowTo)) return;
    setFlow(prev => [...prev, [flowFrom, flowTo]]);
    setFlowTo('');
  }

  function removeFlow(idx: number) { setFlow(prev => prev.filter((_, i) => i !== idx)); }

  async function save() {
    if (!wfId || !wfName) { setError('Process needs an ID and name'); return; }
    setSaving(true); setError(null);
    try {
      const body = { id: wfId, name: wfName, elements, flow } as any;
      const existing = workflows.find(w => w.id === wfId);
      if (existing) { await api.workflows.update(wfId, body); }
      else { await api.workflows.create(body); }
      loadWorkflows();
    } catch (e: any) { setError(e.message); }
    setSaving(false);
  }

  const preview: Workflow = { id: wfId || 'preview', name: wfName || 'Preview', elements, flow, version: '1' };
  const selEl = elements.find(e => e.id === selectedEl);

  return (
    <Layout activePage="editor.html">
      <style>{styles}</style>
      <div className="pe-body">
        <div className="pe-toolbar">
          <span style={{ color: '#94a3b8', fontSize: 12 }}>Process Editor</span>
          <div className="sep" />
          <input type="text" placeholder="Process name..." value={wfName} onChange={e => setWfName(e.target.value)} style={{ width: 200 }} />
          <input type="text" placeholder="ID..." value={wfId} onChange={e => setWfId(e.target.value)} style={{ width: 160 }} />
          <div className="sep" />
          <button className="btn-save" onClick={save} disabled={saving}>{saving ? 'Saving...' : '💾 Save'}</button>
          {error && <span style={{ color: '#fca5a5', fontSize: 12 }}>{error}</span>}
        </div>

        <div className="pe-main">
          <div className="pe-sidebar">
            {/* Load existing */}
            <h3>Load Process</h3>
            <div className="load-select">
              <select value={selectedWfId} onChange={e => setSelectedWfId(e.target.value)}>
                <option value="">— Select —</option>
                {workflows.map(w => <option key={w.id} value={w.id}>{w.name || w.id}</option>)}
              </select>
              <button onClick={() => loadWorkflow(selectedWfId)} disabled={!selectedWfId}>Load</button>
            </div>

            {/* Elements */}
            <h3>Elements ({elements.length})</h3>
            <div className="element-list">
              {elements.map(el => (
                <div key={el.id} className={`element-item${selectedEl === el.id ? ' selected' : ''}`}
                  onClick={() => setSelectedEl(el.id === selectedEl ? null : el.id)}>
                  <div className="element-dot" style={{ background: ELEMENT_TYPES.find(t => t.value === el.type)?.color || '#e2e8f0' }} />
                  <div>
                    <div style={{ fontSize: 13 }}>{el.label}</div>
                    <div className="element-id">{el.id} · {el.type}</div>
                  </div>
                  <button className="element-del" onClick={e => { e.stopPropagation(); removeElement(el.id); }}>✕</button>
                </div>
              ))}
            </div>

            {/* Add element form */}
            <form onSubmit={addElement}>
              <div className="form-group">
                <label>Type</label>
                <select value={newType} onChange={e => setNewType(e.target.value as ElementType)}>
                  {ELEMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Label *</label>
                <input type="text" placeholder="Element label..." value={newLabel} onChange={e => setNewLabel(e.target.value)} required />
              </div>
              {newType === 'function' && (
                <div className="form-group">
                  <label>Role</label>
                  <input type="text" placeholder="Assigned role..." value={newRole} onChange={e => setNewRole(e.target.value)} />
                </div>
              )}
              {newType === 'gateway' && (
                <div className="form-group">
                  <label>Operator</label>
                  <select value={newOperator} onChange={e => setNewOperator(e.target.value)}>
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                    <option value="XOR">XOR</option>
                  </select>
                </div>
              )}
              <button type="submit" className="btn-add">+ Add Element</button>
            </form>

            <div style={{ marginTop: 20 }}>
              <h3>Flow ({flow.length} edges)</h3>
              <div className="element-list">
                {flow.map(([f, t, lbl], i) => (
                  <div key={i} className="flow-item">
                    <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{f}</span>
                    <span className="arrow">→</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{t}</span>
                    {lbl && <span style={{ color: '#888', fontSize: 11 }}>{lbl}</span>}
                    <button className="flow-del" onClick={() => removeFlow(i)}>✕</button>
                  </div>
                ))}
              </div>
              <form onSubmit={addFlow}>
                <div className="form-group">
                  <label>From</label>
                  <select value={flowFrom} onChange={e => setFlowFrom(e.target.value)}>
                    <option value="">— select —</option>
                    {elements.map(e => <option key={e.id} value={e.id}>{e.label} ({e.id})</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>To</label>
                  <select value={flowTo} onChange={e => setFlowTo(e.target.value)}>
                    <option value="">— select —</option>
                    {elements.map(e => <option key={e.id} value={e.id}>{e.label} ({e.id})</option>)}
                  </select>
                </div>
                <button type="submit" className="btn-add">+ Add Connection</button>
              </form>
            </div>
          </div>

          <div className="pe-canvas">
            {elements.length === 0 ? (
              <div className="preview-box">
                <div className="empty-hint">Add elements in the panel to the left, then connect them.<br />The diagram will appear here as you build.</div>
              </div>
            ) : (
              <div className="preview-box">
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>Live Preview — {wfName || 'Untitled'}</div>
                <EpcRenderer workflow={preview} />
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
