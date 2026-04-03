/**
 * KibaPanel — AI admin assistant chat panel (issue #214)
 * Embeds in Agents, Roles, People pages as a collapsible sidebar.
 */
import { useState, useRef, useEffect } from 'react';
import { api } from '../api/client';
import type { KibaAction } from '../api/client';

export const KIBA_CSS = `
  .kiba-panel { width:300px; flex-shrink:0; display:flex; flex-direction:column; background:#0f172a; border-left:1px solid #1e293b; height:calc(100vh - 64px); }
  .kiba-header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #1e293b; }
  .kiba-title { font-size:13px; font-weight:600; color:#e2e8f0; }
  .kiba-btn-close { background:none; border:none; color:#64748b; cursor:pointer; font-size:16px; padding:0 4px; line-height:1; }
  .kiba-btn-close:hover { color:#94a3b8; }
  .kiba-messages { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .kiba-msg { max-width:92%; padding:8px 10px; border-radius:8px; font-size:12px; line-height:1.5; word-break:break-word; }
  .kiba-msg.user { align-self:flex-end; background:#334155; color:#e2e8f0; border-bottom-right-radius:2px; }
  .kiba-msg.assistant { align-self:flex-start; background:#1e3a5f; color:#bfdbfe; border-bottom-left-radius:2px; }
  .kiba-msg.system { align-self:center; background:#064e3b; color:#6ee7b7; font-size:11px; padding:4px 10px; border-radius:12px; }
  .kiba-msg.error { align-self:center; background:#7f1d1d; color:#fca5a5; font-size:11px; padding:4px 10px; border-radius:12px; }
  .kiba-actions { display:flex; flex-direction:column; gap:4px; margin-top:6px; }
  .kiba-action-btn { padding:5px 10px; background:#1e3a5f; border:1px solid #3b82f6; color:#93c5fd; border-radius:4px; cursor:pointer; font-size:11px; text-align:left; line-height:1.4; }
  .kiba-action-btn:hover { background:#1e40af; }
  .kiba-action-btn.danger { border-color:#ef4444; color:#fca5a5; background:#1c1917; }
  .kiba-action-btn.danger:hover { background:#7f1d1d; }
  .kiba-input-row { display:flex; gap:6px; padding:10px 12px; border-top:1px solid #1e293b; }
  .kiba-input { flex:1; background:#1e293b; border:1px solid #334155; border-radius:6px; color:#e2e8f0; font-size:12px; padding:6px 10px; outline:none; resize:none; font-family:inherit; }
  .kiba-input:focus { border-color:#6366f1; }
  .kiba-input::placeholder { color:#475569; }
  .kiba-send { background:#6366f1; border:none; color:white; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px; font-weight:600; flex-shrink:0; }
  .kiba-send:hover { background:#4f46e5; }
  .kiba-send:disabled { opacity:.5; cursor:not-allowed; }
`;

const DANGER_TYPES = new Set(['delete_agent', 'delete_role']);

interface KibaPanelProps {
  page: string;
  contextData: unknown[];
  onClose: () => void;
  onActionDone?: () => void;
}

export function KibaPanel({ page, contextData, onClose, onActionDone }: KibaPanelProps) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant' | 'system' | 'error'; text: string; actions?: KibaAction[] }[]>([]);
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
      const res = await api.kiba.chat({
        message: msg,
        context: { page, data: contextData },
        chat_id: chatId ?? undefined,
      });
      if (!chatId) setChatId(res.chat_id);
      setMsgs(prev => [...prev, { role: 'assistant', text: res.reply, actions: res.actions }]);
    } catch (e: any) {
      setMsgs(prev => [...prev, { role: 'error', text: `Ошибка: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function executeAction(action: KibaAction) {
    const danger = DANGER_TYPES.has(action.type);
    if (danger && !confirm(`Выполнить: ${action.label}?`)) return;
    setBusy(true);
    setMsgs(prev => [...prev, { role: 'system', text: `Выполняю: ${action.label}…` }]);
    try {
      switch (action.type) {
        case 'start_agent':   await api.agents.start(action.args.id as string); break;
        case 'stop_agent':    await api.agents.stop(action.args.id as string); break;
        case 'restart_agent': await api.agents.restart(action.args.id as string); break;
        case 'delete_agent':  await api.agents.delete(action.args.id as string); break;
        case 'create_role':
          await api.roles.create({
            role_id: action.args.role_id as string,
            name: action.args.name as string,
            description: action.args.description as string | undefined,
            strategy: action.args.strategy as string | undefined,
          });
          break;
        case 'delete_role': await api.roles.delete(action.args.role_id as string); break;
        default: throw new Error(`Неизвестное действие: ${action.type}`);
      }
      setMsgs(prev => [...prev, { role: 'system', text: `Готово: ${action.label}` }]);
      onActionDone?.();
    } catch (e: any) {
      setMsgs(prev => [...prev, { role: 'error', text: `Ошибка: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kiba-panel">
      <div className="kiba-header">
        <span className="kiba-title">🐕 Киба — AI-ассистент</span>
        <button className="kiba-btn-close" onClick={onClose}>✕</button>
      </div>
      <div className="kiba-messages">
        {msgs.length === 0 && (
          <div style={{ color: '#475569', fontSize: 11, textAlign: 'center', padding: '16px 0', lineHeight: 1.6 }}>
            Спросите Кибу об агентах, ролях или людях.<br />
            Например: «Какие агенты онлайн?» или «Остановить агента X».
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`kiba-msg ${m.role}`}>
            <div>{m.text}</div>
            {m.actions && m.actions.length > 0 && (
              <div className="kiba-actions">
                {m.actions.map((act, j) => (
                  <button
                    key={j}
                    className={`kiba-action-btn${DANGER_TYPES.has(act.type) ? ' danger' : ''}`}
                    onClick={() => executeAction(act)}
                    disabled={busy}
                  >
                    {act.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="kiba-msg assistant" style={{ opacity: 0.6 }}>Думаю…</div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="kiba-input-row">
        <textarea
          className="kiba-input"
          rows={2}
          placeholder="Сообщение Кибе…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          disabled={busy}
        />
        <button className="kiba-send" onClick={send} disabled={busy || !input.trim()}>
          ↑
        </button>
      </div>
    </div>
  );
}
