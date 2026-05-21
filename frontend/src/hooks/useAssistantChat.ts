/**
 * Chat state and SSE streaming logic for AssistantWidget.
 * Extracted from AssistantWidget.tsx (issue #448).
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Inspector } from '../components/Inspector';
import { useHighlight } from '../components/HighlightOverlay';
import type { SessionRecord, SessionListResult } from '../api/types';

const CHAT_KEY = 'konoha_aw_chat_id';

export interface PendingConfirmation {
  id: string;
  action: string;
  title: string;
  summary: string;
  status: 'required' | 'confirmed' | 'cancelled' | 'expired';
  created_at?: string;
  expires_at?: string;
}

export interface Msg {
  role: 'user' | 'assistant' | 'system';
  text: string;
  images?: string[];
  pending_confirmations?: PendingConfirmation[];
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

export function schemaPatchDurability(ev: any): 'saved' | 'pending' | 'failed' | 'preview' {
  const mode = typeof ev?.edit_result?.mode === 'string' ? ev.edit_result.mode : null;
  if (mode === 'committed') return 'saved';
  if (mode === 'pending_confirmation') return 'pending';
  if (mode === 'failed') return 'failed';
  if (mode === 'preview') return 'preview';
  return 'preview';
}

function schemaPatchSystemText(state: 'saved' | 'pending' | 'failed' | 'preview'): string {
  if (state === 'saved') return 'Схема сохранена на сервере.';
  if (state === 'pending') return 'Изменение подготовлено и ждёт подтверждения.';
  if (state === 'failed') return 'Изменение отклонено серверной проверкой. Холст не изменён.';
  return 'Предпросмотр схемы применён локально. Нажмите 💾 для сохранения.';
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
  pendingConfirmations: PendingConfirmation[];
  confirmAction: (id: string) => Promise<void>;
  cancelAction: (id: string) => Promise<void>;
  sessions: SessionRecord[];
  currentSession: SessionRecord | null;
  sessionsLoading: boolean;
  newSession: () => void;
  switchSession: (chatId: string) => Promise<void>;
  archiveSession: (chatId: string) => Promise<void>;
  deleteSession: (chatId: string) => Promise<void>;
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
  const [pendingConfirmations, setPendingConfirmations] = useState<PendingConfirmation[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [currentSession, setCurrentSession] = useState<SessionRecord | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch('/api/ai/sessions?status=active&limit=20');
      if (res.ok) {
        const data: SessionListResult = await res.json();
        setSessions(data.sessions);
      }
    } catch { /* sessions unavailable — degrade gracefully */ }
    finally { setSessionsLoading(false); }
  }, []);

  const switchSession = useCallback(async (chatId: string) => {
    // Save current chat_id before switching
    setChatId(chatId);
    try { sessionStorage.setItem(CHAT_KEY, chatId); } catch {}
    // Reset messages and load history for the new chat
    setMsgs([]);
    setHistoryLoaded(false);
    setCurrentSession(sessions.find(s => s.chat_id === chatId) ?? null);
  }, [sessions]);

  const newSession = useCallback(() => {
    setChatId(null);
    try { sessionStorage.removeItem(CHAT_KEY); } catch {}
    setMsgs([]);
    setHistoryLoaded(true); // no history to load for a new session
    setCurrentSession(null);
  }, []);

  const archiveSessionAction = useCallback(async (chatId: string) => {
    await fetch(`/api/ai/sessions/${encodeURIComponent(chatId)}/archive`, { method: 'POST' });
    setSessions(prev => prev.filter(s => s.chat_id !== chatId));
    if (currentSession?.chat_id === chatId) {
      newSession();
    }
  }, [currentSession, newSession]);

  const deleteSessionAction = useCallback(async (chatId: string) => {
    await fetch(`/api/ai/sessions/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
    setSessions(prev => prev.filter(s => s.chat_id !== chatId));
    if (currentSession?.chat_id === chatId) {
      newSession();
    }
  }, [currentSession, newSession]);

  // Load sessions on mount
  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Keep currentSession in sync with chatId and sessions
  useEffect(() => {
    if (!chatId) { setCurrentSession(null); return; }
    const match = sessions.find(s => s.chat_id === chatId);
    if (match) { setCurrentSession(match); return; }
    // If chatId exists but not in session list, fetch its metadata
    fetch(`/api/ai/sessions/${encodeURIComponent(chatId)}`)
      .then(res => res.ok ? res.json() : null)
      .then((rec: SessionRecord | null) => {
        if (rec) {
          setCurrentSession(rec);
          setSessions(prev => prev.some(s => s.chat_id === rec.chat_id) ? prev : [rec, ...prev]);
        }
      }).catch(() => {});
  }, [chatId, sessions]);

  // Load chat history on mount if chat_id exists
  useEffect(() => {
    if (!chatId || historyLoaded) return;
    fetch(`/api/ai/chat/${chatId}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.messages && Array.isArray(data.messages)) {
          setMsgs(data.messages.map((m: any) => ({
            role: (m.role === 'user' || m.role === 'assistant' || m.role === 'system') ? m.role : 'system',
            text: m.content ?? m.text ?? '',
          })));
        }
        setHistoryLoaded(true);
      })
      .catch(() => setHistoryLoaded(true));
  }, [chatId, historyLoaded]);

  function abort() { abortRef.current?.abort(); }

  async function confirmAction(id: string) {
    setPendingConfirmations(prev =>
      prev.map(c => c.id === id ? { ...c, status: 'confirmed' as const } : c)
    );
    try {
      const res = await fetch(`/api/ai/confirm/${id}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setPendingConfirmations(prev => prev.filter(c => c.id !== id));
        if (data.operation_id) {
          setMsgs(prev => [...prev, { role: 'system', text: `🔄 ${data.message ?? 'Фоновая операция запущена.'} (ID: ${data.operation_id.slice(0, 8)})` }]);
          // Poll for completion
          pollOperation(data.operation_id);
        } else {
          setMsgs(prev => [...prev, { role: 'system', text: `Действие выполнено: ${data.action ?? id}` }]);
        }
      } else {
        setMsgs(prev => [...prev, { role: 'system', text: `Ошибка подтверждения: ${data.error ?? 'неизвестная ошибка'}` }]);
        setPendingConfirmations(prev =>
          prev.map(c => c.id === id ? { ...c, status: 'required' as const } : c)
        );
      }
    } catch (e: any) {
      setMsgs(prev => [...prev, { role: 'system', text: `Ошибка: ${e.message}` }]);
      setPendingConfirmations(prev =>
        prev.map(c => c.id === id ? { ...c, status: 'required' as const } : c)
      );
    }
  }

  async function pollOperation(opId: string) {
    const maxPolls = 60;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const res = await fetch(`/api/ai/operations/${opId}`);
        if (!res.ok) break;
        const op = await res.json();
        if (op.status === 'done' || op.status === 'error') {
          setMsgs(prev => {
            const last = prev[prev.length - 1];
            if (last?.text?.startsWith('🔄')) {
              return [...prev.slice(0, -1), {
                role: 'system' as const,
                text: op.status === 'done'
                  ? `✅ ${op.progress ?? 'Операция завершена.'}${op.result?.summary ? ' ' + op.result.summary : ''}`
                  : `❌ Ошибка операции: ${op.error ?? 'неизвестная ошибка'}`,
              }];
            }
            return prev;
          });
          break;
        }
        if (i % 5 === 0) {
          setMsgs(prev => {
            const last = prev[prev.length - 1];
            if (last?.text?.startsWith('🔄')) {
              return [...prev.slice(0, -1), { role: 'system' as const, text: `🔄 Выполняется...${op.progress ? ' ' + op.progress : ''}` }];
            }
            return prev;
          });
        }
      } catch { break; }
    }
  }

  async function cancelAction(id: string) {
    setPendingConfirmations(prev =>
      prev.map(c => c.id === id ? { ...c, status: 'cancelled' as const } : c)
    );
    try {
      const res = await fetch(`/api/ai/cancel/${id}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setPendingConfirmations(prev => prev.filter(c => c.id !== id));
        setMsgs(prev => [...prev, { role: 'system', text: `Действие отменено: ${data.action ?? id}` }]);
      } else {
        setPendingConfirmations(prev =>
          prev.map(c => c.id === id ? { ...c, status: 'required' as const } : c)
        );
      }
    } catch (e: any) {
      setMsgs(prev => [...prev, { role: 'system', text: `Ошибка: ${e.message}` }]);
      setPendingConfirmations(prev =>
        prev.map(c => c.id === id ? { ...c, status: 'required' as const } : c)
      );
    }
  }

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
        loadSessions(); // refresh session list with new session
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
              const patchState = ev.schema_patch ? schemaPatchDurability(ev) : null;
              setMsgs(prev => {
                const updated = replyText != null
                  ? [...prev.slice(0, -1), { role: 'assistant' as const, text: replyText }]
                  : [...prev];
                if (patchState) {
                  updated.push({ role: 'system' as const, text: schemaPatchSystemText(patchState) });
                } else if (ev.created_workflow) {
                  updated.push({ role: 'system' as const, text: 'Схема сохранена на сервере.' });
                }
                if (Array.isArray(ev.pending_confirmations) && ev.pending_confirmations.length > 0) {
                  const newConfs: PendingConfirmation[] = ev.pending_confirmations.map((item: any) => ({
                    id: item.id ?? '',
                    action: item.action ?? 'unknown',
                    title: item.title ?? '',
                    summary: item.summary ?? '',
                    status: item.status ?? 'required',
                    created_at: item.created_at,
                    expires_at: item.expires_at,
                  }));
                  setPendingConfirmations(prev => [...prev, ...newConfs]);
                  const labels = ev.pending_confirmations
                    .map((item: any) => typeof item?.action === 'string' ? item.action : 'unknown')
                    .join(', ');
                  const confirmMsg: Msg = {
                    role: 'system' as const,
                    text: `Требуется подтверждение: ${labels}`,
                    pending_confirmations: newConfs,
                  };
                  updated.push(confirmMsg);
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
              if (ev.schema_patch && patchState !== 'failed' && patchState !== 'pending') {
                window.dispatchEvent(new CustomEvent('konoha:schema_patch', { detail: ev.schema_patch }));
                if (patchState === 'saved') {
                  const receipt = Array.isArray(ev.action_receipts)
                    ? ev.action_receipts.find((item: any) => item?.action === 'workflow.patch')
                    : null;
                  window.dispatchEvent(new CustomEvent('konoha:workflow_patch_saved', { detail: receipt }));
                }
              }
              if (ev.created_workflow) {
                window.dispatchEvent(new CustomEvent('konoha:workflow_created', { detail: ev.created_workflow }));
                if (!location.pathname.includes('/editor')) {
                  navigate(`/editor/${ev.created_workflow.id}`);
                }
              }
              if (Array.isArray(ev.actions) && ev.actions.length > 0) {
                const act = ev.actions[0];
                if (act.type === 'highlight' && (act.target || act.selector)) {
                  showHighlight({ selector: act.target ?? act.selector, style: act.style ?? 'spotlight', message: act.message });
                } else if (act.type === 'navigate') {
                  const target = typeof act.path === 'string' ? act.path : typeof act.target === 'string' ? act.target : null;
                  if (target) navigate(target);
                }
              }
            } else if (ev.type === 'chat_id') {
              setChatId(ev.chat_id);
              try { sessionStorage.setItem(CHAT_KEY, ev.chat_id); } catch {}
              loadSessions(); // refresh session list with new session
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

  return { msgs, input, setInput, busy, attachments, setAttachments, send, abort, pendingConfirmations, confirmAction, cancelAction, sessions, currentSession, sessionsLoading, newSession, switchSession, archiveSession: archiveSessionAction, deleteSession: deleteSessionAction };
}
