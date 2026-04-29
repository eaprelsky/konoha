/**
 * TsunadeChatPanel — floating AI assistant panel in ProcessEditor.
 * Extracted from ProcessEditor.tsx (issue #289).
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkflowElement, ProcessMiningData } from '../api/types';
import { api } from '../api/client';
import type { Pos } from './ArrowRouter';
import { useHighlight } from '../components/HighlightOverlay';

export interface SchemaPatch {
  update_elements?: { id: string; [key: string]: unknown }[];
  update_positions?: Record<string, Pos>;
  add_elements?: { id?: string; x?: number; y?: number; type?: string; label?: string; [key: string]: unknown }[];
  remove_elements?: string[];
}

export interface TsunadeChatPanelProps {
  show: boolean;
  onClose: () => void;
  wfId: string;
  wfName: string;
  elements: WorkflowElement[];
  flow: [string, string, string?][];
  positions: Record<string, Pos>;
  showMining: boolean;
  miningData: ProcessMiningData | null;
  onApplyPatch: (patch: SchemaPatch) => void;
}

type ChatMsg = { role: 'user' | 'assistant' | 'system' | 'error'; text: string };

export function TsunadeChatPanel({
  show, onClose, wfId, wfName, elements, flow, positions,
  showMining, miningData, onApplyPatch,
}: TsunadeChatPanelProps) {
  const navigate = useNavigate();
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const { showHighlight } = useHighlight();

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMsgs]);

  async function send() {
    const msg = chatInput.trim();
    if (!msg || chatBusy) return;
    setChatInput('');
    setChatMsgs(prev => [...prev, { role: 'user', text: msg }]);
    setChatBusy(true);
    const schema: Record<string, unknown> = { id: wfId, name: wfName, elements, flow, positions };
    if (showMining && miningData) {
      schema.mining = {
        case_count: miningData.case_count,
        bottleneck_element_id: miningData.bottleneck_element_id,
        skipped_elements: miningData.skipped_elements,
        deviation_elements: miningData.deviation_elements,
        elements: Object.fromEntries(
          Object.entries(miningData.elements).map(([id, s]) => [id, {
            label: s.label, visit_count: s.visit_count, avg_duration_ms: s.avg_duration_ms,
          }])
        ),
      };
    }
    try {
      const res = await api.assistant.chat({ message: msg, schema, chat_id: chatId ?? undefined, mode: 'process' });
      if (!chatId) setChatId(res.chat_id);
      setChatMsgs(prev => [...prev, { role: 'assistant', text: res.reply }]);
      const patch = res.schema_patch as SchemaPatch | undefined;
      if (patch) {
        onApplyPatch(patch);
        const hasChanges = patch.update_elements?.length || patch.update_positions
          || patch.add_elements?.length || patch.remove_elements?.length;
        if (hasChanges) {
          setChatMsgs(prev => [...prev, { role: 'system', text: 'Схема обновлена. Нажмите 💾 для сохранения.' }]);
        }
      }
      if (Array.isArray(res.pending_confirmations) && res.pending_confirmations.length > 0) {
        const labels = res.pending_confirmations.map(item => item.action).join(', ');
        setChatMsgs(prev => [...prev, { role: 'system', text: `Требуется подтверждение: ${labels}` }]);
      }
      const actionReceipts = res.action_receipts ?? [];
      if (actionReceipts.length > 0) {
        setChatMsgs(prev => [...prev, ...actionReceipts
          .filter(r => typeof r.summary === 'string' && r.summary)
          .map(r => ({ role: 'system' as const, text: `[${r.status}] ${r.summary}` }))]);
      } else if (res.observable_result?.summary) {
        setChatMsgs(prev => [...prev, { role: 'system', text: res.observable_result!.summary }]);
      }
      if (res.created_workflow) {
        window.dispatchEvent(new CustomEvent('konoha:workflow_created', { detail: res.created_workflow }));
        navigate(`/editor/${res.created_workflow.id}`);
      }
      if (res.actions && res.actions.length > 0) {
        const act = res.actions[0];
        if (act.type === 'highlight') {
          showHighlight({ selector: act.selector, style: act.style ?? 'spotlight', message: act.message });
        }
      }
    } catch (e: any) {
      setChatMsgs(prev => [...prev, { role: 'error', text: `Ошибка: ${e.message}` }]);
    } finally {
      setChatBusy(false);
    }
  }

  if (!show) return null;

  return (
    <div className="tsunade-panel">
      <div className="tsunade-header">
        <span className="tsunade-title">💬 Цунаде — AI-ассистент</span>
        <button className="tsunade-btn-close" onClick={onClose}>✕</button>
      </div>
      <div className="tsunade-messages">
        {chatMsgs.length === 0 && (
          <div style={{ color: '#94a3b8', fontSize: 12, textAlign: 'center', padding: '20px 0' }}>
            Спросите Цунаде о схеме.<br />
            Например: «Выровняй элементы вертикально» или «Добавь шлюз XOR после функции X».
          </div>
        )}
        {chatMsgs.map((m, i) => (
          <div key={i} className={`tsunade-msg ${m.role}`}>{m.text}</div>
        ))}
        {chatBusy && (
          <div className="tsunade-msg assistant" style={{ opacity: 0.6 }}>Думаю…</div>
        )}
        <div ref={chatBottomRef} />
      </div>
      <div className="tsunade-input-row">
        <textarea
          className="tsunade-input"
          rows={2}
          placeholder="Сообщение Цунаде…"
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button
          className="tsunade-send"
          disabled={chatBusy || !chatInput.trim()}
          onClick={send}
        >
          ➤
        </button>
      </div>
    </div>
  );
}
