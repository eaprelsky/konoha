import { useState, useEffect } from 'react';
import { api } from '../../api/client';

interface TmuxModalProps { agentId: string; onClose: () => void; }

export function TmuxModal({ agentId, onClose }: TmuxModalProps) {
  const [lines, setLines] = useState('Loading...');

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    api.agents.tmuxLog(agentId)
      .then(d => setLines(d.lines || '(empty)'))
      .catch(e => setLines('Error: ' + e.message));
    return () => document.removeEventListener('keydown', h);
  }, [agentId, onClose]);

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 700, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: 16 }}>tmux: {agentId}</h2>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#888' }} onClick={onClose}>×</button>
        </div>
        <pre style={{ flex: 1, overflow: 'auto', background: '#0d1117', color: '#e6edf3', padding: 16, borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{lines}</pre>
      </div>
    </div>
  );
}
