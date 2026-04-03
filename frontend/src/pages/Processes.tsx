import { useState, useCallback, useEffect } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { EpcRenderer } from '../components/EpcRenderer';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import type { Workflow } from '../api/types';

const styles = `
  .layout { display: grid; grid-template-columns: 300px 1fr; gap: 0; height: calc(100vh - 100px); }
  .sidebar { background: #fff; border-right: 1px solid #e2e8f0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; }
  .sidebar-top { display: flex; gap: 8px; margin-bottom: 12px; }
  .sidebar-top button { padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; background: white; }
  .btn-new-proc { background: #0066cc !important; color: white !important; border-color: #0066cc !important; }
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
  .proc-actions { display: none; gap: 2px; }
  .process-item:hover .proc-actions, .process-item.active .proc-actions { display: flex; }
  .proc-actions button { padding: 1px 5px; font-size: 11px; border: 1px solid #ddd; border-radius: 3px; background: white; cursor: pointer; color: #555; }
  .proc-actions button:hover { background: #f0f0f0; }
  .proc-actions .del-btn { color: #ef4444; border-color: #fca5a5; }
  .main { overflow-y: auto; padding: 24px; }
  .main .placeholder { color: #94a3b8; font-size: 15px; padding-top: 60px; text-align: center; }
  .proc-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
  .proc-header h2 { font-size: 18px; font-weight: 700; }
  .proc-header .meta { font-size: 12px; color: #64748b; margin-top: 4px; }
  .proc-header-actions { display: flex; gap: 8px; }
  .proc-header-actions button { padding: 6px 12px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .proc-header-actions .del { color: #ef4444; border-color: #fca5a5; }
  .diagram-box { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; overflow-x: auto; margin-bottom: 20px; }
  .diagram-box h3 { font-size: 13px; color: #64748b; margin-bottom: 12px; }
  .loading { color: #94a3b8; font-size: 14px; padding: 40px 0; text-align: center; }
  .error-msg { color: #ef4444; font-size: 13px; }
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 24px; width: 480px; max-width: 95vw; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 18px; color: #333; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus { outline: none; border-color: #0066cc; }
  .form-group .hint { font-size: 11px; color: #888; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-primary { background: #0066cc; color: white; }
  .btn-cancel-f { background: #e5e7eb; color: #374151; }
  .error-banner { background: #fee; color: #c33; padding: 10px 14px; border-radius: 4px; margin-bottom: 12px; border-left: 4px solid #c33; font-size: 13px; }
`;

function slugify(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function groupByCategory(wfs: Workflow[]) {
  const groups: Record<string, Workflow[]> = {};
  wfs.forEach(wf => {
    const cat = (wf as any).category || wf.id.split('/')[0] || 'general';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(wf);
  });
  return groups;
}

interface NewProcessModalProps { onClose: () => void; onCreated: (wf: Workflow) => void; }
function NewProcessModal({ onClose, onCreated }: NewProcessModalProps) {
  const [name, setName] = useState('');
  const [wfId, setWfId] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idTouched, setIdTouched] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    if (!idTouched) setWfId(slugify(name));
  }, [name, idTouched]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !wfId.trim()) { setError('Введите название и ID'); return; }
    setSubmitting(true); setError(null);
    const fullId = category.trim() ? `${slugify(category)}/${wfId}` : wfId;
    try {
      const wf = await api.workflows.create({
        id: fullId, name, description: description || undefined,
        category: category || undefined, elements: [], flow: [],
      } as any);
      onCreated(wf); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>Новый процесс</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Название *</label>
            <input type="text" placeholder="Название процесса..." value={name} onChange={e => setName(e.target.value)} autoFocus required />
          </div>
          <div className="form-group">
            <label>ID *</label>
            <input type="text" placeholder="например: lead-qualification" value={wfId}
              onChange={e => { setWfId(e.target.value); setIdTouched(true); }} required />
            <span className="hint">Slug-ID. Категория добавится как префикс папки.</span>
          </div>
          <div className="form-group">
            <label>Категория</label>
            <input type="text" placeholder="например: sales (опционально)" value={category} onChange={e => setCategory(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Описание</label>
            <input type="text" placeholder="Опционально..." value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel-f" onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={submitting}>{submitting ? 'Создание…' : 'Создать'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CategoryNode({ cat, items, selectedId, onSelect, onDuplicate, onDelete, onExport }: {
  cat: string; items: Workflow[]; selectedId: string | null;
  onSelect: (wf: Workflow) => void; onDuplicate: (wf: Workflow) => void;
  onDelete: (wf: Workflow) => void; onExport: (wf: Workflow) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="category">
      <div className={`category-label${open ? ' open' : ''}`} onClick={() => setOpen(o => !o)}>
        <span className="arrow">▶</span> {cat} <span style={{ color: '#94a3b8', fontSize: 11 }}>({items.length})</span>
      </div>
      {open && (
        <div className="category-items open">
          {items.map(wf => (
            <div key={wf.id} className={`process-item${selectedId === wf.id ? ' active' : ''}`} onClick={() => onSelect(wf)}>
              <span>{wf.name || wf.id}</span>
              <div className="proc-actions" onClick={e => e.stopPropagation()}>
                <button title="Копировать" onClick={() => onDuplicate(wf)}>⎘</button>
                <button title="Экспорт JSON" onClick={() => onExport(wf)}>↓</button>
                <button className="del-btn" title="Удалить" onClick={() => onDelete(wf)}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Processes() {
  const { data: workflows, loading, error, refetch } = useApi(() => api.workflows.list());
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  const groups = workflows ? groupByCategory(workflows) : {};

  const handleCreated = useCallback((wf: Workflow) => { refetch?.(); setSelected(wf); }, [refetch]);

  async function duplicate(wf: Workflow) {
    const newId = wf.id + '-copy-' + Date.now().toString(36);
    try {
      const copy = await api.workflows.create({ ...wf, id: newId, name: wf.name + ' (копия)' } as any);
      refetch?.(); setSelected(copy);
    } catch (e: any) { setOpError(e.message); }
  }

  async function deleteWf(wf: Workflow) {
    if (!confirm(`Архивировать процесс "${wf.name || wf.id}"?`)) return;
    try {
      await api.workflows.delete(wf.id);
      refetch?.();
      if (selected?.id === wf.id) setSelected(null);
    } catch (e: any) { setOpError(e.message); }
  }

  function exportWf(wf: Workflow) {
    const blob = new Blob([JSON.stringify(wf, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `${wf.id}.json`; a.click(); URL.revokeObjectURL(url);
  }

  function importWf() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      try { const wf = JSON.parse(await file.text()); await api.workflows.create(wf); refetch?.(); }
      catch (e: any) { setOpError(e.message); }
    };
    input.click();
  }

  return (
    <Layout activePage="processes.html">
      <style>{styles}</style>
      <div className="layout">
        <div className="sidebar">
          <div className="sidebar-top">
            <button className="btn-new-proc" onClick={() => setShowNew(true)}>+ Новый</button>
            <button onClick={importWf} title="Import JSON">↑ Импорт</button>
          </div>
          <h2>Реестр процессов</h2>
          {opError && <div className="error-banner">{opError} <button style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setOpError(null)}>✕</button></div>}
          <div id="tree">
            {loading && <div className="loading">Loading…</div>}
            {error && <div className="error-msg">Failed to load: {error}</div>}
            {!loading && !error && Object.keys(groups).length === 0 && (
              <div style={{ color: '#94a3b8', fontSize: 13 }}>Нет процессов. Нажмите + Новый для создания.</div>
            )}
            {Object.entries(groups).map(([cat, items]) => (
              <CategoryNode key={cat} cat={cat} items={items} selectedId={selected?.id ?? null}
                onSelect={setSelected} onDuplicate={duplicate} onDelete={deleteWf} onExport={exportWf} />
            ))}
          </div>
        </div>
        <div className="main" id="main">
          {!selected ? (
            <div className="placeholder">← Выберите процесс для просмотра диаграммы</div>
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
                <div className="proc-header-actions">
                  <button onClick={() => duplicate(selected)}>⎘ Дублировать</button>
                  <button onClick={() => exportWf(selected)}>↓ Экспорт</button>
                  <button className="del" onClick={() => deleteWf(selected)}>✕ Удалить</button>
                </div>
              </div>
              <div className="diagram-box">
                <h3>Диаграмма eEPC</h3>
                <EpcRenderer workflow={selected} />
              </div>
            </>
          )}
        </div>
      </div>
      {showNew && <NewProcessModal onClose={() => setShowNew(false)} onCreated={handleCreated} />}
    </Layout>
  );
}
