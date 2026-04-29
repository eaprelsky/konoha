/**
 * Chat state and SSE streaming logic for AssistantWidget.
 * Extracted from AssistantWidget.tsx (issue #448).
 */
import { useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Inspector } from '../components/Inspector';
import { useHighlight } from '../components/HighlightOverlay';

const CHAT_KEY = 'konoha_aw_chat_id';

export interface Msg {
  role: 'user' | 'assistant' | 'system';
  text: string;
  images?: string[];
}

export interface AttachmentImg {
  data: string;
  mime: string;
  name: string;
  dataUrl: string;
}

/** Parse partial/in-progress JSON reply from SSE delta stream.
 *  If the accumulated text looks like raw JSON (no reply field extracted),
 *  return a placeholder to avoid flashing machine-readable content to the user.
 *  The final `parsed` SSE event will replace this with the clean reply text. */
function extractStreamingText(raw: string): string {
  const m = raw.match(/"reply"\s*:\s*"([\s\S]*)/);
  if (m) {
    return m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  // Text looks like raw JSON or other machine format — suppress it
  if (raw.trimStart().startsWith('{') || raw.trimStart().startsWith('```')) {
    return '';
  }
  return raw;
}

function formatReceiptSummary(receipt: any): string {
  if (!receipt || typeof receipt !== 'object') return '';
  const summary = typeof receipt.summary === 'string' ? receipt.summary : '';
  const status = typeof receipt.status === 'string' ? receipt.status : 'unknown';
  if (!summary) return '';
  return `[${status}] ${summary}`;
}

export interface UseAssistantChatResult {
  msgs: Msg[];
  input: string;
  setInput: (v: string) => void;
  busy: boolean;
  attachments: AttachmentImg[];
  setAttachments: (fn: (prev: AttachmentImg[]) => AttachmentImg[]) => void;
  send: () => Promise<void>;
  abort: () => void;
}

/** Optional overrides for router dependencies — inject in tests to avoid Router wrapper. */
export interface UseAssistantChatOptions {
  navigate?: (to: string) => void;
  location?: { pathname: string };
}

export function useAssistantChat(options: UseAssistantChatOptions = {}): UseAssistantChatResult {
  // Always call router hooks (Rules of Hooks) — overrides apply in tests/isolation.
  const routerNavigate = useNavigate();
  const routerLocation = useLocation();
  const navigate = options.navigate ?? routerNavigate;
  const location = options.location ?? routerLocation;
  const { showHighlight } = useHighlight();

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatId, setChatId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(CHAT_KEY); } catch { return null; }
  });
  const [attachments, setAttachments] = useState<AttachmentImg[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  function abort() { abortRef.current?.abort(); }

  async function send() {
    const msg = input.trim();
    if (!msg && attachments.length === 0) return;
    if (busy) return;

    setInput('');
    const sentAttachments = attachments;
    setAttachments(() => []);
    Inspector.trackAction(`assistant: ${msg.slice(0, 60)}`);
    setMsgs(prev => [...prev, {
      role: 'user',
      text: msg,
      images: sentAttachments.length > 0 ? sentAttachments.map(a => a.dataUrl) : undefined,
    }]);
    setBusy(true);

    const context = Inspector.snapshot();
    const operatorState = Inspector.operatorState();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Streaming placeholder
    setMsgs(prev => [...prev, { role: 'assistant', text: '' }]);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg || '(см. вложения)',
          context,
          operator_state: operatorState || undefined,
          chat_id: chatId || undefined,
          mode: 'process',
          stream: true,
          images: sentAttachments.length > 0
            ? sentAttachments.map(a => ({ data: a.data, mime: a.mime, name: a.name }))
            : undefined,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const headerChatId = res.headers.get('X-Chat-Id');
      if (headerChatId && !chatId) {
        setChatId(headerChatId);
        try { sessionStorage.setItem(CHAT_KEY, headerChatId); } catch {}
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const dec = new TextDecoder();
      let buf = '';
      let full = '';
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') { streamDone = true; break; }
          try {
            const ev = JSON.parse(payload);
            if (ev.type === 'delta' && typeof ev.text === 'string') {
              full += ev.text;
              setMsgs(prev => [...prev.slice(0, -1), { role: 'assistant', text: extractStreamingText(full) }]);
            } else if (ev.type === 'parsed') {
              const replyText = typeof ev.reply === 'string' ? ev.reply : null;
              setMsgs(prev => {
                const updated = replyText != null
                  ? [...prev.slice(0, -1), { role: 'assistant' as const, text: replyText }]
                  : [...prev];
                if (ev.schema_patch || ev.created_workflow) {
                  updated.push({ role: 'system' as const, text: 'Схема обновлена. Нажмите 💾 для сохранения.' });
                }
                if (Array.isArray(ev.pending_confirmations) && ev.pending_confirmations.length > 0) {
                  const labels = ev.pending_confirmations
                    .map((item: any) => typeof item?.action === 'string' ? item.action : 'unknown')
                    .join(', ');
                  updated.push({ role: 'system' as const, text: `Требуется подтверждение: ${labels}` });
                }
                if (Array.isArray(ev.action_receipts) && ev.action_receipts.length > 0) {
                  for (const receipt of ev.action_receipts) {
                    const text = formatReceiptSummary(receipt);
                    if (text) updated.push({ role: 'system' as const, text });
                  }
                } else if (ev.observable_result && typeof ev.observable_result.summary === 'string' && ev.observable_result.summary) {
                  updated.push({ role: 'system' as const, text: ev.observable_result.summary });
                }
                return updated;
              });
              if (ev.schema_patch) {
                const applySchemaPatch = (window as any).__konoha_apply_schema_patch;
                if (typeof applySchemaPatch === 'function') applySchemaPatch(ev.schema_patch);
                window.dispatchEvent(new CustomEvent('konoha:schema_patch', { detail: ev.schema_patch }));
              }
              if (ev.created_workflow) {
                window.dispatchEvent(new CustomEvent('konoha:workflow_created', { detail: ev.created_workflow }));
                if (!location.pathname.includes('/editor')) {
                  navigate(`/editor/${ev.created_workflow.id}`);
                }
              }
              if (Array.isArray(ev.actions) && ev.actions.length > 0) {
                const act = ev.actions[0];
                if (act.type === 'highlight' && act.target) {
                  showHighlight({ selector: act.target, style: act.style ?? 'spotlight', message: act.message });
                } else if (act.type === 'navigate') {
                  const target = typeof act.path === 'string' ? act.path : typeof act.target === 'string' ? act.target : null;
                  if (target) navigate(target);
                }
              }
            } else if (ev.type === 'chat_id') {
              setChatId(ev.chat_id);
              try { sessionStorage.setItem(CHAT_KEY, ev.chat_id); } catch {}
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setMsgs(prev => prev.slice(0, -1));
        return;
      }
      setMsgs(prev => [...prev.slice(0, -1), { role: 'error' as any, text: `Ошибка: ${e.message}` }]);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return { msgs, input, setInput, busy, attachments, setAttachments, send, abort };
}
