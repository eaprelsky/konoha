import { useState, useCallback, useEffect } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { RoleDef, AssignmentStrategy } from '../api/types';

const STRATEGIES: AssignmentStrategy[] = ['manual', 'round-robin', 'load-balancing', 'broadcast'];

const styles = `
  .rl-body { padding: 20px; }
  .container { max-width: 1000px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .btn-new { padding: 8px 18px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn-new:hover { background: #0052a3; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: middle; }
  .table tr:hover td { background: #fafafa; }
  .tag { display: inline-block; padding: 2px 8px; background: #eff6ff; color: #1d4ed8; border-radius: 10px; font-size: 11px; margin: 1px; }
  .strategy-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: #f0fdf4; color: #15803d; }
  .actions { display: flex; gap: 6px; }
  .actions button { padding: 5px 10px; border: 1px solid #ddd; background: white; border-radius: 3px; cursor: pointer; font-size: 12px; }
  .actions .edit { background: #3b82f6; color: white; border-color: #3b82f6; }
  .actions .del { background: #ef4444; color: white; border-color: #ef4444; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 24px; width: 480px; max-width: 95vw; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 18px; color: #333; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input, .form-group select, .form-group textarea { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: #0066cc; }
  .form-group .hint { font-size: 11px; color: #888; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-submit { background: #0066cc; color: white; }
  .btn-cancel-f { background: #e5e7eb; color: #374151; }
`;

interface RoleModalProps { role?: RoleDef | null; onClose: () => void; onSaved: () => void; }
function RoleModal({ role, onClose, onSaved }: RoleModalProps) {
  const [roleId, setRoleId] = useState(role?.role_id || '');
  const [name, setName] = useState(role?.name || '');
  const [description, setDescription] = useState(role?.description || '');
  const [assignees, setAssignees] = useState((role?.assignees || []).join(', '));
  const [strategy, setStrategy] = useState<AssignmentStrategy>(role?.strategy || 'manual');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    const assigneeList = assignees.split(',').map(s => s.trim()).filter(Boolean);
    setSubmitting(true); setError(null);
    try {
      if (role) {
        await api.roles.update(role.role_id, { name, description, assignees: assigneeList, strategy });
      } else {
        if (!roleId.trim()) { setError('Role ID is required'); setSubmitting(false); return; }
        await api.roles.create({ role_id: roleId.trim(), name, description, assignees: assigneeList, strategy });
      }
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{role ? 'Edit Role' : 'New Role'}</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          {!role && (
            <div className="form-group">
              <label>Role ID *</label>
              <input type="text" placeholder="e.g. sales-manager" value={roleId} onChange={e => setRoleId(e.target.value)} autoFocus required />
            </div>
          )}
          <div className="form-group">
            <label>Name *</label>
            <input type="text" placeholder="Display name..." value={name} onChange={e => setName(e.target.value)} autoFocus={!!role} required />
          </div>
          <div className="form-group">
            <label>Description</label>
            <input type="text" placeholder="Optional description..." value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Assignees</label>
            <input type="text" placeholder="agent1, agent2, @user..." value={assignees} onChange={e => setAssignees(e.target.value)} />
            <span className="hint">Comma-separated agent IDs or user handles</span>
          </div>
          <div className="form-group">
            <label>Assignment Strategy</label>
            <select value={strategy} onChange={e => setStrategy(e.target.value as AssignmentStrategy)}>
              {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
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

export function Roles() {
  const token = useToken();
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editRole, setEditRole] = useState<RoleDef | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    api.roles.list()
      .then(data => { setRoles(data); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 30000);

  async function deleteRole(id: string) {
    if (!confirm(`Delete role "${id}"?`)) return;
    try { await api.roles.delete(id); load(); } catch (e: any) { setError(e.message); }
  }

  function openEdit(r: RoleDef) { setEditRole(r); setShowModal(true); }
  function openNew() { setEditRole(null); setShowModal(true); }

  return (
    <Layout activePage="roles.html">
      <style>{styles}</style>
      <div className="rl-body">
        <div className="container">
          <div className="page-header">
            <h1>Roles</h1>
            <button className="btn-new" onClick={openNew}>+ New Role</button>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Loading...</div>}
          {!loading && roles.length === 0 && <div className="empty">No roles defined yet.</div>}
          {roles.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Strategy</th>
                  <th>Assignees</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.map(r => (
                  <tr key={r.role_id}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.role_id}</td>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td style={{ color: '#666' }}>{r.description || '-'}</td>
                    <td><span className="strategy-badge">{r.strategy}</span></td>
                    <td>{r.assignees.map(a => <span key={a} className="tag">{a}</span>)}{r.assignees.length === 0 && '-'}</td>
                    <td>
                      <div className="actions">
                        <button className="edit" onClick={() => openEdit(r)}>Edit</button>
                        <button className="del" onClick={() => deleteRole(r.role_id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {showModal && <RoleModal role={editRole} onClose={() => setShowModal(false)} onSaved={load} />}
    </Layout>
  );
}
