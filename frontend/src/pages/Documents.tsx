import { useState, useCallback, useEffect } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { DocTemplate, DocType } from '../api/types';

const DOC_TYPES: DocType[] = ['prompt', 'instruction', 'form', 'template', 'attachment'];

const styles = `
  .dc-body { padding: 20px; }
  .container { max-width: 1100px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .btn-new { padding: 8px 18px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn-new:hover { background: #0052a3; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: middle; }
  .table tr:hover td { background: #fafafa; }
  .type-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .type-prompt { background: #ede9fe; color: #5b21b6; }
  .type-instruction { background: #dbeafe; color: #1e40af; }
  .type-form { background: #fef3c7; color: #92400e; }
  .type-template { background: #f0fdf4; color: #15803d; }
  .type-attachment { background: #f1f5f9; color: #475569; }
  .param-tag { display: inline-block; padding: 1px 6px; background: #fff7ed; color: #c2410c; border-radius: 4px; font-size: 11px; margin: 1px; font-family: monospace; }
  .preview { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #666; font-size: 12px; font-family: monospace; }
  .actions { display: flex; gap: 6px; }
  .actions button { padding: 5px 10px; border: 1px solid #ddd; background: white; border-radius: 3px; cursor: pointer; font-size: 12px; }
  .actions .edit { background: #3b82f6; color: white; border-color: #3b82f6; }
  .actions .del { background: #ef4444; color: white; border-color: #ef4444; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 24px; width: 600px; max-width: 95vw; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 18px; color: #333; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input, .form-group select, .form-group textarea { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: #0066cc; }
  .form-group textarea { resize: vertical; min-height: 180px; font-family: monospace; font-size: 13px; }
  .form-group .hint { font-size: 11px; color: #888; }
  .detected-params { font-size: 12px; color: #888; margin-top: 4px; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-submit { background: #0066cc; color: white; }
  .btn-cancel-f { background: #e5e7eb; color: #374151; }
`;

function detectParams(content: string): string[] {
  const m = content.match(/\{\{(\w+)\}\}/g) || [];
  return [...new Set(m.map(x => x.slice(2, -2)))];
}

interface DocModalProps { doc?: DocTemplate | null; onClose: () => void; onSaved: () => void; }
function DocModal({ doc, onClose, onSaved }: DocModalProps) {
  const [name, setName] = useState(doc?.name || '');
  const [type, setType] = useState<DocType>(doc?.type || 'template');
  const [content, setContent] = useState(doc?.content || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const params = detectParams(content);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    setSubmitting(true); setError(null);
    try {
      if (doc) { await api.documents.update(doc.doc_id, { name, type, content }); }
      else { await api.documents.create({ name, type, content }); }
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{doc ? 'Edit Document' : 'New Document'}</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Name *</label>
            <input type="text" placeholder="Template name..." value={name} onChange={e => setName(e.target.value)} autoFocus required />
          </div>
          <div className="form-group">
            <label>Type</label>
            <select value={type} onChange={e => setType(e.target.value as DocType)}>
              {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Content</label>
            <textarea placeholder="Template content. Use {{placeholder}} for parameters..." value={content} onChange={e => setContent(e.target.value)} />
            <span className="hint">Use {'{{placeholder}}'} syntax for dynamic parameters</span>
            {params.length > 0 && (
              <div className="detected-params">
                Detected: {params.map(p => <span key={p} className="param-tag" style={{ display: 'inline-block', padding: '1px 6px', background: '#fff7ed', color: '#c2410c', borderRadius: 4, fontSize: 11, margin: '0 2px', fontFamily: 'monospace' }}>{'{{' + p + '}}'}</span>)}
              </div>
            )}
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel-f" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-submit" disabled={submitting}>{submitting ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Documents() {
  const token = useToken();
  const [docs, setDocs] = useState<DocTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editDoc, setEditDoc] = useState<DocTemplate | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    api.documents.list()
      .then(data => { setDocs(data); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 30000);

  async function deleteDoc(id: string, name: string) {
    if (!confirm(`Delete document "${name}"?`)) return;
    try { await api.documents.delete(id); load(); } catch (e: any) { setError(e.message); }
  }

  return (
    <Layout activePage="documents.html">
      <style>{styles}</style>
      <div className="dc-body">
        <div className="container">
          <div className="page-header">
            <h1>Documents</h1>
            <button className="btn-new" onClick={() => { setEditDoc(null); setShowModal(true); }}>+ New Document</button>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Loading...</div>}
          {!loading && docs.length === 0 && <div className="empty">No document templates yet.</div>}
          {docs.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Preview</th>
                  <th>Parameters</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {docs.map(d => (
                  <tr key={d.doc_id}>
                    <td style={{ fontWeight: 600 }}>{d.name}</td>
                    <td><span className={`type-badge type-${d.type}`}>{d.type}</span></td>
                    <td><div className="preview">{d.content || '(empty)'}</div></td>
                    <td>{d.parameters.map(p => <span key={p} className="param-tag">{'{{' + p + '}}'}</span>)}{d.parameters.length === 0 && '-'}</td>
                    <td style={{ fontSize: 12, color: '#888' }}>{new Date(d.updated_at).toLocaleDateString()}</td>
                    <td>
                      <div className="actions">
                        <button className="edit" onClick={() => { setEditDoc(d); setShowModal(true); }}>Edit</button>
                        <button className="del" onClick={() => deleteDoc(d.doc_id, d.name)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {showModal && <DocModal doc={editDoc} onClose={() => setShowModal(false)} onSaved={load} />}
    </Layout>
  );
}
