/**
 * TsunadePanel — AI process-editor assistant chat panel
 * Collapsible sidebar for the ProcessEditor page.
 * Receives the current workflow schema as a prop and sends it with each message.
 */
import { useState, useRef, useEffect } from 'react';
import { api } from '../api/client';

export const TSUNADE_PANEL_CSS = `
  .tsunade-panel { width:320px; flex-shrink:0; display:flex; flex-direction:column; background:#fff; border-left:1px solid #e2e8f0; height:100%; }
  .tsunade-header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #e2e8f0; background:#f8fafc; }
  .tsunade-title { font-size:13px; font-weight:600; color:#1e293b; }
  .tsunade-btn-close { background:none; border:none; color:#94a3b8; cursor:pointer; font-size:16px; padding:0 4px; line-height:1; }
  .tsunade-btn-close:hover { color:#475569; }
  .tsunade-messages { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; background:#f8fafc; }
  .tsunade-msg { max-width:90%; padding:8px 10px; border-radius:8px; font-size:13px; line-height:1.5; word-break:break-word; }
  .tsunade-msg.user { align-self:flex-end; background:#eff6ff; color:#1d4ed8; border-bottom-right-radius:2px; }
  .tsunade-msg.assistant { align-self:flex-start; background:#fff; color:#1e293b; border:1px solid #e2e8f0; border-bottom-left-radius:2px; }
  .tsunade-msg.system { align-self:center; background:#f0fdf4; color:#15803d; font-size:11px; padding:4px 10px; border-radius:12px; }
  .tsunade-msg.error { align-self:center; background:#fef2f2; color:#dc2626; font-size:11px; padding:4px 10px; border-radius:12px; }
  .tsunade-input-row { display:flex; gap:6px; padding:10px 12px; border-top:1px solid #e2e8f0; background:#fff; }
  .tsunade-input { flex:1; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; color:#1e293b; font-size:13px; padding:7px 10px; outline:none; resize:none; font-family:inherit; }
  .tsunade-input:focus { border-color:#6366f1; }
  .tsunade-input::placeholder { color:#94a3b8; }
  .tsunade-send { background:#6366f1; border:none; color:white; border-radius:6px; padding:7px 12px; cursor:pointer; font-size:13px; font-weight:600; flex-shrink:0; }
  .tsunade-send:hover { background:#4f46e5; }
  .tsunade-send:disabled { opacity:.5; cursor:not-allowed; }
`;

export interface WorkflowSchema {
  id: string;
  name: string;
  elements: unknown[];
  flow: unknown[];
  positions: Record<string, { x: number; y: number }>;
  mining?: unknown;
}

interface TsunadePanelProps {
  schema: WorkflowSchema;
  onClose: () => void;
  onSchemaPatch?: (patch: unknown) => void;
}

export function TsunadePanel({ schema, onClose, onSchemaPatch }: TsunadePanelProps) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant' | 'system' | 'error'; text: string }[]>([]);
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
      const res = await api.tsunade.processChat({
        message: msg,
        schema,
        chat_id: chatId ?? undefined,
      });
      if (!chatId) setChatId(res.chat_id);
      setMsgs(prev => [...prev, { role: 'assistant', text: res.reply }]);

      if (res.schema_patch && onSchemaPatch) {
        onSchemaPatch(res.schema_patch);
        setMsgs(prev => [...prev, { role: 'system', text: 'Схема обновлена. Нажмите 💾 для сохранения.' }]);
      }
    } catch (e: any) {
      setMsgs(prev => [...prev, { role: 'error', text: `Ошибка: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tsunade-panel">
      <div className="tsunade-header">
        <span className="tsunade-title">💬 Цунаде — AI-ассистент</span>
        <button className="tsunade-btn-close" onClick={onClose}>✕</button>
      </div>
      <div className="tsunade-messages">
        {msgs.length === 0 && (
          <div style={{ color: '#94a3b8', fontSize: 11, textAlign: 'center', padding: '16px 0', lineHeight: 1.7 }}>
            Спросите Цунаде об этом процессе.<br />
            Например: «Выровняй элементы» или<br />
            «Добавь шаг согласования».
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`tsunade-msg ${m.role}`}>{m.text}</div>
        ))}
        {busy && (
          <div className="tsunade-msg assistant" style={{ opacity: 0.6 }}>Думаю…</div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="tsunade-input-row">
        <textarea
          className="tsunade-input"
          rows={2}
          placeholder="Сообщение Цунаде…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          disabled={busy}
        />
        <button className="tsunade-send" onClick={send} disabled={busy || !input.trim()}>
          ↑
        </button>
      </div>
    </div>
  );
}
