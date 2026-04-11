import { useState, useEffect } from 'react';
import { api } from '../../api/client';

interface MemoryFile { name: string; size: number; updated_at: string; }

interface AgentMemoryTabProps {
  agentId: string;
  onClose: () => void;
}

export function AgentMemoryTab({ agentId, onClose }: AgentMemoryTabProps) {
  const [memFiles, setMemFiles] = useState<MemoryFile[]>([]);
  const [memContent, setMemContent] = useState<{ name: string; text: string } | null>(null);
  const [memLoading, setMemLoading] = useState(false);
  const [memEditing, setMemEditing] = useState(false);
  const [memEditText, setMemEditText] = useState('');
  const [memSaving, setMemSaving] = useState(false);
  const [memError, setMemError] = useState<string | null>(null);
  const [memCreating, setMemCreating] = useState(false);
  const [memNewName, setMemNewName] = useState('');

  function loadMemory() {
    setMemLoading(true);
    api.agents.memoryList(agentId)
      .then(files => { setMemFiles(files); setMemLoading(false); })
      .catch(() => setMemLoading(false));
  }

  useEffect(() => { loadMemory(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function openFile(filename: string) {
    setMemError(null);
    const text = await api.agents.memoryRead(agentId, filename).catch(() => '(ошибка чтения)');
    setMemContent({ name: filename, text });
    setMemEditing(false);
    setMemEditText(text);
  }

  async function deleteFile(filename: string) {
    if (!confirm(`Удалить файл памяти "${filename}"? Это действие необратимо.`)) return;
    await api.agents.memoryDelete(agentId, filename).catch(() => {});
    if (memContent?.name === filename) { setMemContent(null); setMemEditing(false); }
    loadMemory();
  }

  async function saveFile() {
    if (!memContent) return;
    setMemSaving(true); setMemError(null);
    try {
      await api.agents.memorySave(agentId, memContent.name, memEditText);
      setMemContent({ name: memContent.name, text: memEditText });
      setMemEditing(false);
      loadMemory();
    } catch (e: any) {
      setMemError(e.message);
    } finally {
      setMemSaving(false);
    }
  }

  async function createFile() {
    const fname = memNewName.trim();
    if (!fname) return;
    const name = fname.endsWith('.md') || fname.endsWith('.txt') || fname.endsWith('.json') ? fname : `${fname}.md`;
    setMemSaving(true); setMemError(null);
    try {
      await api.agents.memoryCreate(agentId, name, '');
      setMemCreating(false); setMemNewName('');
      loadMemory();
      setMemContent({ name, text: '' });
      setMemEditing(true); setMemEditText('');
    } catch (e: any) {
      setMemError(e.message);
    } finally {
      setMemSaving(false);
    }
  }

  return (
    <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {memError && <div className="error-banner">{memError}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Файлы памяти</span>
        <button
          onClick={() => { setMemCreating(v => !v); setMemNewName(''); setMemError(null); }}
          style={{ padding: '4px 12px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
        >+ Новый файл</button>
      </div>

      {memCreating && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 10px', background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' }}>
          <input
            autoFocus
            value={memNewName}
            onChange={e => setMemNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') createFile(); if (e.key === 'Escape') { setMemCreating(false); setMemNewName(''); } }}
            placeholder="имя_файла.md"
            style={{ flex: 1, padding: '5px 8px', border: '1px solid #86efac', borderRadius: 4, fontSize: 13, fontFamily: 'monospace' }}
          />
          <button onClick={createFile} disabled={memSaving || !memNewName.trim()}
            style={{ padding: '5px 12px', background: '#16a34a', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: !memNewName.trim() ? 0.5 : 1 }}>
            Создать
          </button>
          <button onClick={() => { setMemCreating(false); setMemNewName(''); }}
            style={{ padding: '5px 8px', background: 'white', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
            Отмена
          </button>
        </div>
      )}

      {memLoading && <div style={{ color: '#94a3b8', fontSize: 13, padding: '8px 0' }}>Загрузка…</div>}
      {!memLoading && memFiles.length === 0 && !memCreating && (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: '8px 0' }}>Файлов памяти нет. Нажмите «+ Новый файл».</div>
      )}
      {!memLoading && memFiles.length > 0 && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 6, overflow: 'hidden' }}>
          {memFiles.map((f, i) => (
            <div key={f.name} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
              background: memContent?.name === f.name ? '#eff6ff' : (i % 2 === 0 ? '#fafafa' : 'white'),
              borderBottom: i < memFiles.length - 1 ? '1px solid #f1f5f9' : undefined,
            }}>
              <span style={{ flex: 1, fontSize: 12, fontFamily: 'monospace', color: '#334155', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                onClick={() => openFile(f.name)} title={f.name}>{f.name}</span>
              <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>{(f.size / 1024).toFixed(1)} KB</span>
              <button onClick={() => openFile(f.name)}
                style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #e2e8f0', background: memContent?.name === f.name ? '#dbeafe' : 'white', color: '#3b82f6', borderRadius: 4, cursor: 'pointer', fontWeight: 500 }}>
                Открыть
              </button>
              <button onClick={() => deleteFile(f.name)}
                style={{ padding: '3px 8px', fontSize: 11, border: '1px solid #fca5a5', background: 'white', color: '#ef4444', borderRadius: 4, cursor: 'pointer', fontWeight: 500 }}>
                Удалить
              </button>
            </div>
          ))}
        </div>
      )}

      {memContent && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#334155', fontFamily: 'monospace' }}>{memContent.name}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {memEditing ? (
                <>
                  <button onClick={saveFile} disabled={memSaving}
                    style={{ padding: '4px 12px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: memSaving ? 0.6 : 1 }}>
                    {memSaving ? 'Сохранение…' : '💾 Сохранить'}
                  </button>
                  <button onClick={() => { setMemEditing(false); setMemEditText(memContent.text); }}
                    style={{ padding: '4px 10px', background: 'white', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                    Отмена
                  </button>
                </>
              ) : (
                <button onClick={() => { setMemEditing(true); setMemEditText(memContent.text); }}
                  style={{ padding: '4px 12px', background: '#f1f5f9', color: '#374151', border: '1px solid #e2e8f0', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  ✏️ Редактировать
                </button>
              )}
              <button onClick={() => { setMemContent(null); setMemEditing(false); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1, padding: '0 2px' }}>×</button>
            </div>
          </div>
          {memEditing ? (
            <textarea
              value={memEditText}
              onChange={e => setMemEditText(e.target.value)}
              style={{ width: '100%', minHeight: 260, fontFamily: 'monospace', fontSize: 12, background: 'white', border: 'none', padding: 12, resize: 'vertical', color: '#1e293b', boxSizing: 'border-box', outline: 'none' }}
            />
          ) : (
            <textarea readOnly value={memContent.text}
              style={{ width: '100%', minHeight: 260, fontFamily: 'monospace', fontSize: 12, background: '#f8fafc', border: 'none', padding: 12, resize: 'vertical', color: '#475569', cursor: 'default', boxSizing: 'border-box' }}
            />
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
        <button className="btn-cancel-f" onClick={onClose}>Закрыть</button>
      </div>
    </div>
  );
}
