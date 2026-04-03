/**
 * KibaPanel — AI admin assistant chat panel (issue #214)
 * Embeds in Agents, Roles, People pages as a collapsible sidebar.
 */
import { useState, useRef, useEffect } from 'react';
import { api } from '../api/client';
import type { KibaAction } from '../api/client';

export const KIBA_CSS = `
  .kiba-panel { width:300px; flex-shrink:0; display:flex; flex-direction:column; background:#fff; border-left:1px solid #e2e8f0; height:100%; }
  .kiba-header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid #e2e8f0; background:#f8fafc; }
  .kiba-title { font-size:13px; font-weight:600; color:#1e293b; }
  .kiba-btn-close { background:none; border:none; color:#94a3b8; cursor:pointer; font-size:16px; padding:0 4px; line-height:1; }
  .kiba-btn-close:hover { color:#475569; }
  .kiba-messages { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:10px; background:#f8fafc; }
  .kiba-msg { max-width:92%; padding:8px 10px; border-radius:8px; font-size:12px; line-height:1.5; word-break:break-word; }
  .kiba-msg.user { align-self:flex-end; background:#eff6ff; color:#1d4ed8; border-bottom-right-radius:2px; }
  .kiba-msg.assistant { align-self:flex-start; background:#fff; color:#1e293b; border:1px solid #e2e8f0; border-bottom-left-radius:2px; }
  .kiba-msg.system { align-self:center; background:#f0fdf4; color:#15803d; font-size:11px; padding:4px 10px; border-radius:12px; }
  .kiba-msg.error { align-self:center; background:#fef2f2; color:#dc2626; font-size:11px; padding:4px 10px; border-radius:12px; }
  .kiba-actions { display:flex; flex-direction:column; gap:4px; margin-top:6px; }
  .kiba-action-btn { padding:5px 10px; background:#eff6ff; border:1px solid #93c5fd; color:#1d4ed8; border-radius:4px; cursor:pointer; font-size:11px; text-align:left; line-height:1.4; }
  .kiba-action-btn:hover { background:#dbeafe; }
  .kiba-action-btn.danger { border-color:#fca5a5; color:#dc2626; background:#fef2f2; }
  .kiba-action-btn.danger:hover { background:#fee2e2; }
  .kiba-input-row { display:flex; gap:6px; padding:10px 12px; border-top:1px solid #e2e8f0; background:#fff; }
  .kiba-input { flex:1; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; color:#1e293b; font-size:12px; padding:6px 10px; outline:none; resize:none; font-family:inherit; }
  .kiba-input:focus { border-color:#6366f1; }
  .kiba-input::placeholder { color:#94a3b8; }
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
          <div style={{ color: '#94a3b8', fontSize: 11, textAlign: 'center', padding: '16px 0', lineHeight: 1.6 }}>
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
