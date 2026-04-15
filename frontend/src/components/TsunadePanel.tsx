/**
 * TsunadePanel — AI process-editor assistant chat panel
 * Collapsible sidebar for the ProcessEditor page.
 * Receives the current workflow schema as a prop and sends it with each message.
 *
 * @deprecated Dead code — not imported anywhere. Replaced by TsunadeChatPanel + AssistantWidget.
 * See ADR-002 (#525) for context. Remove in next cleanup sweep.
 */
import { useState, useRef, useEffect } from 'react';
import { api, uploadAttachment, type AttachmentRef } from '../api/client';
import { useHighlight } from './HighlightOverlay';

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
  .tsunade-input-row { display:flex; gap:6px; padding:10px 12px; border-top:1px solid #e2e8f0; background:#fff; align-items:flex-end; }
  .tsunade-input { flex:1; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; color:#1e293b; font-size:13px; padding:7px 10px; outline:none; resize:none; font-family:inherit; }
  .tsunade-input:focus { border-color:#6366f1; }
  .tsunade-input::placeholder { color:#94a3b8; }
  .tsunade-send { background:#6366f1; border:none; color:white; border-radius:6px; padding:7px 12px; cursor:pointer; font-size:13px; font-weight:600; flex-shrink:0; }
  .tsunade-send:hover { background:#4f46e5; }
  .tsunade-send:disabled { opacity:.5; cursor:not-allowed; }
  .tsunade-attach-btn { background:none; border:1px solid #e2e8f0; border-radius:6px; color:#64748b; cursor:pointer; font-size:15px; padding:6px 8px; flex-shrink:0; line-height:1; }
  .tsunade-attach-btn:hover { background:#f1f5f9; color:#1e293b; }
  .tsunade-attachments { display:flex; flex-wrap:wrap; gap:6px; padding:6px 12px 0; }
  .tsunade-att-chip { display:flex; align-items:center; gap:4px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:6px; padding:3px 8px; font-size:11px; color:#1d4ed8; max-width:160px; }
  .tsunade-att-chip span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tsunade-att-remove { background:none; border:none; color:#93c5fd; cursor:pointer; font-size:12px; padding:0 0 0 2px; line-height:1; flex-shrink:0; }
  .tsunade-att-remove:hover { color:#1d4ed8; }
  .tsunade-att-img { max-width:100%; max-height:80px; border-radius:4px; display:block; margin-top:4px; border:1px solid #e2e8f0; }
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
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant' | 'system' | 'error'; text: string; thumb?: string }[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { showHighlight } = useHighlight();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setUploading(true);
    try {
      const uploaded: AttachmentRef[] = [];
      const newThumbs: Record<string, string> = {};
      for (const file of files) {
        const ref = await uploadAttachment(file, 'tsunade-user');
        uploaded.push(ref);
        if (file.type.startsWith('image/')) {
          newThumbs[ref.path] = URL.createObjectURL(file);
        }
      }
      setAttachments(prev => [...prev, ...uploaded]);
      setThumbs(prev => ({ ...prev, ...newThumbs }));
    } catch (e: any) {
      setMsgs(prev => [...prev, { role: 'error', text: `Ошибка загрузки: ${e.message}` }]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function send() {
    const msg = input.trim();
    if ((!msg && attachments.length === 0) || busy) return;
    const sentAttachments = [...attachments];
    setInput('');
    setAttachments([]);

    const userText = [msg, ...sentAttachments.map(a => `📎 ${a.name}`)].filter(Boolean).join('\n');
    setMsgs(prev => [...prev, { role: 'user', text: userText }]);
    setBusy(true);
    try {
      const res = await api.tsunade.processChat({
        message: msg || '(см. вложения)',
        schema,
        chat_id: chatId ?? undefined,
        attachments: sentAttachments.length > 0 ? sentAttachments : undefined,
      });
      if (!chatId) setChatId(res.chat_id);
      setMsgs(prev => [...prev, { role: 'assistant', text: res.reply }]);

      if (res.schema_patch && onSchemaPatch) {
        onSchemaPatch(res.schema_patch);
        setMsgs(prev => [...prev, { role: 'system', text: 'Схема обновлена. Нажмите 💾 для сохранения.' }]);
      }

      if (res.actions && res.actions.length > 0) {
        const act = res.actions[0];
        if (act.type === 'highlight') {
          showHighlight({ selector: act.selector, style: act.style ?? 'spotlight', message: act.message });
        }
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
            «Добавь шаг согласования».<br />
            Можно прикрепить скриншот или спеку.
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

      {/* Pending attachments preview */}
      {attachments.length > 0 && (
        <div className="tsunade-attachments">
          {attachments.map((att, i) => (
            <div key={i} className="tsunade-att-chip">
              {thumbs[att.path] ? (
                <img src={thumbs[att.path]} className="tsunade-att-img" alt={att.name} />
              ) : (
                <span>📎</span>
              )}
              <span title={att.name}>{att.name}</span>
              <button
                className="tsunade-att-remove"
                onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                title="Убрать"
              >✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="tsunade-input-row">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.txt,.md"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <button
          className="tsunade-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy || uploading}
          title="Прикрепить файл (изображение, PDF, текст)"
        >
          {uploading ? '⏳' : '📎'}
        </button>
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
        <button className="tsunade-send" onClick={send} disabled={busy || uploading || (!input.trim() && attachments.length === 0)}>
          ↑
        </button>
      </div>
    </div>
  );
}
