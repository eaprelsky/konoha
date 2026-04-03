/**
 * JiraiyaPanel — AI KB assistant chat panel (issue #215)
 * Collapsible sidebar for the KB section.
 */
import { useState, useRef, useEffect } from 'react';
import { api } from '../api/client';

export const JIRAIYA_CSS = `
  .jiraiya-panel { width:320px; flex-shrink:0; display:flex; flex-direction:column; background:#fff; border-left:1px solid #e2e8f0; height:100%; }
  .jiraiya-header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #e2e8f0; background:#f8fafc; }
  .jiraiya-title { font-size:13px; font-weight:600; color:#1e293b; }
  .jiraiya-btn-close { background:none; border:none; color:#94a3b8; cursor:pointer; font-size:16px; padding:0 4px; line-height:1; }
  .jiraiya-btn-close:hover { color:#475569; }
  .jiraiya-messages { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; background:#f8fafc; }
  .jiraiya-msg { max-width:95%; padding:8px 10px; border-radius:8px; font-size:12px; line-height:1.5; word-break:break-word; }
  .jiraiya-msg.user { align-self:flex-end; background:#eff6ff; color:#1d4ed8; border-bottom-right-radius:2px; }
  .jiraiya-msg.assistant { align-self:flex-start; background:#fff; color:#1e293b; border:1px solid #e2e8f0; border-bottom-left-radius:2px; }
  .jiraiya-msg.system { align-self:center; background:#f0fdf4; color:#15803d; font-size:11px; padding:4px 10px; border-radius:12px; }
  .jiraiya-msg.error { align-self:center; background:#fef2f2; color:#dc2626; font-size:11px; padding:4px 10px; border-radius:12px; }
  .jiraiya-sources { margin-top:6px; display:flex; flex-direction:column; gap:2px; }
  .jiraiya-source { display:flex; align-items:center; gap:4px; font-size:10px; color:#64748b; font-family:monospace; padding:2px 0; }
  .jiraiya-source-link { color:#6366f1; cursor:pointer; text-decoration:none; }
  .jiraiya-source-link:hover { text-decoration:underline; color:#4f46e5; }
  .jiraiya-input-row { display:flex; gap:6px; padding:10px 12px; border-top:1px solid #e2e8f0; background:#fff; }
  .jiraiya-input { flex:1; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; color:#1e293b; font-size:12px; padding:6px 10px; outline:none; resize:none; font-family:inherit; }
  .jiraiya-input:focus { border-color:#6366f1; }
  .jiraiya-input::placeholder { color:#94a3b8; }
  .jiraiya-send { background:#6366f1; border:none; color:white; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px; font-weight:600; flex-shrink:0; }
  .jiraiya-send:hover { background:#4f46e5; }
  .jiraiya-send:disabled { opacity:.5; cursor:not-allowed; }
  .jiraiya-context-bar { padding:6px 12px; border-bottom:1px solid #e2e8f0; font-size:10px; color:#64748b; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; background:#f8fafc; }
`;

interface JiraiyaPanelProps {
  filePath: string | null;
  onFileSelect?: (path: string) => void;
  onClose: () => void;
}

export function JiraiyaPanel({ filePath, onFileSelect, onClose }: JiraiyaPanelProps) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<{
    role: 'user' | 'assistant' | 'system' | 'error';
    text: string;
    sources?: string[];
  }[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  async function send() {
    const msg = input.trim();
    if (!msg || busy) return;
    setInput('');
    setMsgs(prev => [...prev, { role: 'user', text: msg }]);
    setBusy(true);
    try {
      const res = await api.jiraiya.chat({
        message: msg,
        file_path: filePath ?? undefined,
        chat_id: chatId ?? undefined,
      });
      if (!chatId) setChatId(res.chat_id);
      setMsgs(prev => [...prev, { role: 'assistant', text: res.reply, sources: res.sources }]);
    } catch (e: any) {
      setMsgs(prev => [...prev, { role: 'error', text: `Ошибка: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jiraiya-panel">
      <div className="jiraiya-header">
        <span className="jiraiya-title">📜 Дзирайя — KB-ассистент</span>
        <button className="jiraiya-btn-close" onClick={onClose}>✕</button>
      </div>
      {filePath && (
        <div className="jiraiya-context-bar" title={filePath}>
          📄 {filePath}
        </div>
      )}
      <div className="jiraiya-messages">
        {msgs.length === 0 && (
          <div style={{ color: '#94a3b8', fontSize: 11, textAlign: 'center', padding: '16px 0', lineHeight: 1.7 }}>
            Задайте вопрос по базе знаний.<br />
            Например: «Как настроить агента?»<br />
            или «Резюмируй этот документ».
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`jiraiya-msg ${m.role}`}>
            <div>{m.text}</div>
            {m.sources && m.sources.length > 0 && (
              <div className="jiraiya-sources">
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>Источники:</div>
                {m.sources.map((src, j) => (
                  <div key={j} className="jiraiya-source">
                    <span>📄</span>
                    {onFileSelect ? (
                      <span
                        className="jiraiya-source-link"
                        onClick={() => onFileSelect(src)}
                      >{src}</span>
                    ) : (
                      <span>{src}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="jiraiya-msg assistant" style={{ opacity: 0.6 }}>Ищу в базе знаний…</div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="jiraiya-input-row">
        <textarea
          className="jiraiya-input"
          rows={2}
          placeholder="Вопрос по базе знаний…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          disabled={busy}
        />
        <button className="jiraiya-send" onClick={send} disabled={busy || !input.trim()}>
          ↑
        </button>
      </div>
    </div>
  );
}
