import { useState, useEffect } from 'react';
import type React from 'react';
import { api } from '../../api/client';

interface NewAgentModalProps { onClose: () => void; onCreated: () => void; }

export function NewAgentModal({ onClose, onCreated }: NewAgentModalProps) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('claude:claude-sonnet-4-6');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!id.trim() || !name.trim()) { setError('Укажите ID и имя'); return; }
    setSubmitting(true); setError(null);
    try {
      await api.agents.create({ id: id.trim(), name: name.trim(), model, system_prompt: prompt || undefined });
      onCreated(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>Новый агент</h2>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={submit}>
          <div className="form-group">
            <label>ID агента *</label>
            <input type="text" placeholder="например: my-agent" value={id} onChange={e => setId(e.target.value)} autoFocus required />
          </div>
          <div className="form-group">
            <label>Имя *</label>
            <input type="text" placeholder="Отображаемое имя..." value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Модель</label>
            <select value={model} onChange={e => setModel(e.target.value)}>
              <option value="claude:claude-sonnet-4-6">Claude: Sonnet 4.6</option>
              <option value="claude:claude-opus-4-6">Claude: Opus 4.6</option>
              <option value="claude:claude-haiku-4-5-20251001">Claude: Haiku 4.5</option>
              <option value="codex:gpt-5">Codex: GPT-5</option>
              <option value="codex:o4-mini">Codex: o4-mini</option>
              <option value="cursor:auto">Cursor: Auto</option>
              <option value="cursor:claude-4-sonnet">Cursor: Claude 4 Sonnet</option>
              <option value="cursor:gpt-5.4-medium">Cursor: GPT-5.4</option>
            </select>
          </div>
          <div className="form-group">
            <div style={{ padding: '8px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 4, marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 2 }}>Системные инструкции (Layer 1)</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>Авто-инжектируются Konoha при старте: регистрация, watchdog, память. Не редактируются.</div>
            </div>
            <label>Пользовательские инструкции (Layer 2)</label>
            <textarea placeholder="Роль, специализация, типы задач, поведение..." value={prompt} onChange={e => setPrompt(e.target.value)} />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-cancel-f" onClick={onClose}>Отмена</button>
            <button type="submit" className="btn-submit" disabled={submitting}>{submitting ? 'Создание…' : 'Создать'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
