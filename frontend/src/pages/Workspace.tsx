import { useState, useCallback, useEffect, useRef } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { WorkspaceFile } from '../api/types';

const ALLOWED_EXT = ['.docx', '.xlsx', '.pdf', '.png', '.jpg', '.wav', '.mp3', '.m4a', '.ogg'];

const styles = `
  .ws-body { padding: 20px; }
  .container { max-width: 900px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .page-subtitle { font-size: 13px; color: #94a3b8; margin-top: 2px; }
  .header-right { display: flex; gap: 8px; align-items: center; }
  .btn-upload { padding: 7px 16px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; white-space: nowrap; }
  .btn-upload:hover { background: #0052a3; }
  .btn-upload:disabled { opacity: 0.6; cursor: not-allowed; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: middle; }
  .table tr:hover td { background: #fafafa; }
  .file-name { font-family: monospace; font-size: 13px; color: #1e293b; }
  .file-ext { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px; margin-left: 6px; font-family: monospace; background: #f1f5f9; color: #475569; }
  .file-size { color: #94a3b8; font-size: 13px; }
  .file-date { color: #94a3b8; font-size: 13px; }
  .btn-delete { padding: 3px 8px; background: transparent; color: #dc2626; border: 1px solid #fca5a5; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-delete:hover { background: #fee2e2; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .success-banner { background: #f0fdf4; color: #166534; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #22c55e; }
  .drop-zone { border: 2px dashed #cbd5e1; border-radius: 8px; padding: 32px; text-align: center; color: #94a3b8; font-size: 14px; margin-bottom: 16px; transition: border-color .15s, background .15s; cursor: pointer; }
  .drop-zone.drag-over { border-color: #0066cc; background: #eff6ff; color: #0066cc; }
  .allowed-hint { font-size: 11px; color: #94a3b8; margin-top: 6px; }
`;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

export function Workspace() {
  const token = useToken();
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    if (!token) return;
    api.workspace.list()
      .then(data => { setFiles(data); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 30000);

  async function uploadFile(file: File) {
    const ext = getExt(file.name);
    if (!ALLOWED_EXT.includes(ext)) {
      setError(`Формат не поддерживается: ${ext}. Разрешено: ${ALLOWED_EXT.join(', ')}`);
      return;
    }
    setUploading(true); setError(null); setSuccess(null);
    try {
      const result = await api.workspace.upload(file);
      setSuccess(`Файл загружен: ${result.name} (${formatSize(result.size)})`);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    e.target.value = '';
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  }

  async function deleteFile(name: string) {
    if (!confirm(`Удалить файл "${name}"?`)) return;
    try {
      await api.workspace.delete(name);
      setSuccess(`Файл удалён: ${name}`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <Layout activePage="workspace.html">
      <style>{styles}</style>
      <div className="ws-body">
        <div className="container">
          <div className="page-header">
            <div>
              <h1>Workspace</h1>
              <div className="page-subtitle">/opt/shared/workspace — общая папка для артефактов процессов</div>
            </div>
            <div className="header-right">
              <button className="btn-upload" disabled={uploading} onClick={() => inputRef.current?.click()}>
                {uploading ? 'Загрузка…' : '+ Загрузить файл'}
              </button>
              <input ref={inputRef} type="file" style={{ display: 'none' }} onChange={onFileInput} />
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}
          {success && <div className="success-banner">{success}</div>}

          <div
            className={`drop-zone${dragOver ? ' drag-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            Перетащите файл сюда или нажмите для выбора
            <div className="allowed-hint">{ALLOWED_EXT.join(' · ')}</div>
          </div>

          {loading && <div className="empty">Загрузка…</div>}
          {!loading && files.length === 0 && <div className="empty">Папка пуста.</div>}
          {!loading && files.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Файл</th>
                  <th>Размер</th>
                  <th>Изменён</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {files.map(f => (
                  <tr key={f.name}>
                    <td>
                      <span className="file-name">{f.name}</span>
                      <span className="file-ext">{getExt(f.name)}</span>
                    </td>
                    <td className="file-size">{formatSize(f.size)}</td>
                    <td className="file-date">{new Date(f.modified_at).toLocaleString('ru-RU')}</td>
                    <td style={{ width: 60, textAlign: 'right' }}>
                      <button className="btn-delete" onClick={() => deleteFile(f.name)}>Удалить</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}
