/**
 * AssistantWidget — floating AI assistant panel (closes #293)
 *
 * - position: fixed, z-index 9999, outside router (no remounts)
 * - Draggable (position persisted in localStorage)
 * - 3 states: collapsed → expanded → fullscreen
 * - Ctrl+/ toggles open/close
 * - SSE streaming via POST /api/ai/chat
 * - Inspector context auto-attached to every request
 */

import { useState, useRef, useEffect } from 'react';
import { Inspector } from './Inspector';
import { useBranding } from '../context/BrandingContext';

type WidgetState = 'collapsed' | 'expanded' | 'fullscreen';

interface Msg {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

const POS_KEY = 'konoha_aw_pos';
const CHAT_KEY = 'konoha_aw_chat_id';

/** Detect mode by current pathname */
function detectMode(): 'process' | 'admin' {
  const p = location.pathname;
  if (/\/(editor|monitor|processes|cases|workitems|calendar|my-calendar|my-tasks|reminders)/.test(p)) return 'process';
  return 'admin';
}

function defaultPos() {
  return { x: Math.max(0, window.innerWidth - 432), y: Math.max(0, window.innerHeight - 532) };
}

const CSS = `
  .aw-trigger {
    position: fixed; bottom: 24px; right: 24px; z-index: 9999;
    width: 48px; height: 48px; border-radius: 50%;
    background: #6366f1; border: none; color: white; font-size: 20px;
    cursor: pointer; box-shadow: 0 4px 16px rgba(99,102,241,.45);
    transition: transform .15s, box-shadow .15s;
    display: flex; align-items: center; justify-content: center;
  }
  .aw-trigger:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(99,102,241,.6); }

  .aw-panel {
    position: fixed; z-index: 9999;
    background: #fff; border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,.18);
    display: flex; flex-direction: column; overflow: hidden;
  }
  .aw-panel.expanded { width: 400px; height: 500px; resize: both; min-width: 280px; min-height: 300px; }
  .aw-panel.fullscreen {
    top: 0 !important; left: 0 !important;
    width: 100vw !important; height: 100vh !important;
    border-radius: 0; resize: none;
  }

  .aw-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; background: #0f172a; color: #f8fafc;
    cursor: move; user-select: none; flex-shrink: 0;
  }
  .aw-title { flex: 1; font-size: 13px; font-weight: 600; letter-spacing: .3px; }
  .aw-hbtn {
    background: none; border: none; color: #64748b; cursor: pointer;
    font-size: 15px; padding: 2px 5px; line-height: 1; border-radius: 4px;
    transition: color .1s, background .1s;
  }
  .aw-hbtn:hover { color: #f8fafc; background: rgba(255,255,255,.1); }

  .aw-hint {
    padding: 3px 14px; font-size: 10px; color: #94a3b8;
    background: #f8fafc; border-bottom: 1px solid #e2e8f0;
    flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .aw-messages {
    flex: 1; overflow-y: auto; padding: 12px;
    display: flex; flex-direction: column; gap: 8px; background: #f8fafc;
  }
  .aw-msg {
    max-width: 92%; padding: 8px 11px; border-radius: 8px;
    font-size: 12px; line-height: 1.55; word-break: break-word; white-space: pre-wrap;
  }
  .aw-msg.user  { align-self: flex-end; background: #eff6ff; color: #1d4ed8; border-bottom-right-radius: 2px; }
  .aw-msg.assistant {
    align-self: flex-start; background: #fff; color: #1e293b;
    border: 1px solid #e2e8f0; border-bottom-left-radius: 2px;
  }
  .aw-msg.assistant.streaming { border-color: #6366f1; }
  .aw-msg.system {
    align-self: center; background: #f0fdf4; color: #15803d;
    font-size: 11px; padding: 4px 12px; border-radius: 12px;
  }
  .aw-msg.error {
    align-self: center; background: #fef2f2; color: #dc2626;
    font-size: 11px; padding: 4px 12px; border-radius: 12px;
  }
  .aw-cursor { display: inline-block; animation: aw-blink .7s step-end infinite; }
  @keyframes aw-blink { 0%,100%{opacity:1} 50%{opacity:0} }

  .aw-input-row {
    display: flex; gap: 6px; padding: 10px 12px;
    border-top: 1px solid #e2e8f0; background: #fff; flex-shrink: 0;
    align-items: flex-end;
  }
  .aw-input {
    flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
    color: #1e293b; font-size: 12px; padding: 7px 10px; outline: none;
    resize: none; font-family: inherit; min-height: 36px; max-height: 120px;
    overflow-y: auto; line-height: 1.5;
  }
  .aw-input:focus { border-color: #6366f1; }
  .aw-input::placeholder { color: #94a3b8; }
  .aw-input:disabled { opacity: .6; cursor: not-allowed; }
  .aw-send {
    background: #6366f1; border: none; color: white; border-radius: 6px;
    padding: 7px 12px; cursor: pointer; font-size: 13px; font-weight: 600;
    flex-shrink: 0; transition: background .15s;
  }
  .aw-send:hover:not(:disabled) { background: #4f46e5; }
  .aw-send:disabled { opacity: .45; cursor: not-allowed; }
`;

export function AssistantWidget() {
  const branding = useBranding();
  const [widgetState, setWidgetState] = useState<WidgetState>('collapsed');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatId, setChatId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(CHAT_KEY); } catch { return null; }
  });
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try { const s = localStorage.getItem(POS_KEY); return s ? JSON.parse(s) : defaultPos(); }
    catch { return defaultPos(); }
  });

  const bottomRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keyboard shortcut Ctrl+/
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === '/') {
        e.preventDefault();
        setWidgetState(s => s === 'collapsed' ? 'expanded' : 'collapsed');
      }
      if (e.key === 'Escape') {
        setWidgetState(s => {
          if (s === 'fullscreen') return 'expanded';
          if (s === 'expanded') return 'collapsed';
          return s;
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  // Persist chat_id
  useEffect(() => {
    try { if (chatId) sessionStorage.setItem(CHAT_KEY, chatId); } catch {}
  }, [chatId]);

  // Drag: start
  function onDragStart(e: React.MouseEvent) {
    if (widgetState === 'fullscreen') return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
    e.preventDefault();
  }

  // Drag: move / end
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const { sx, sy, px, py } = dragRef.current;
      const newPos = { x: px + e.clientX - sx, y: py + e.clientY - sy };
      setPos(newPos);
      try { localStorage.setItem(POS_KEY, JSON.stringify(newPos)); } catch {}
    }
    function onUp() { dragRef.current = null; }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  async function send() {
    const msg = input.trim();
    if (!msg || busy) return;
    setInput('');
    Inspector.trackAction(`assistant: ${msg.slice(0, 60)}`);
    setMsgs(prev => [...prev, { role: 'user', text: msg }]);
    setBusy(true);

    const context = Inspector.snapshot();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Streaming placeholder
    setMsgs(prev => [...prev, { role: 'assistant', text: '' }]);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          context,
          chat_id: chatId || undefined,
          mode: detectMode(),
          stream: true,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const headerChatId = res.headers.get('X-Chat-Id');
      if (headerChatId && !chatId) setChatId(headerChatId);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const dec = new TextDecoder();
      let buf = '';
      let full = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') break;
          try {
            const ev = JSON.parse(payload);
            if (ev.type === 'delta' && typeof ev.text === 'string') {
              full += ev.text;
              setMsgs(prev => [...prev.slice(0, -1), { role: 'assistant', text: full }]);
            } else if (ev.type === 'chat_id') {
              setChatId(ev.chat_id);
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setMsgs(prev => prev.slice(0, -1)); // remove placeholder
        return;
      }
      setMsgs(prev => [...prev.slice(0, -1), { role: 'error' as any, text: `Ошибка: ${e.message}` }]);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  // ── Collapsed state: just the trigger button ──────────────────────────────
  if (widgetState === 'collapsed') {
    return (
      <>
        <style>{CSS}</style>
        <button
          className="aw-trigger"
          onClick={() => setWidgetState('expanded')}
          title="Ассистент (Ctrl+/)"
        >
          💬
        </button>
      </>
    );
  }

  // ── Expanded / Fullscreen panel ───────────────────────────────────────────
  const panelStyle: React.CSSProperties =
    widgetState === 'fullscreen' ? {} : { left: pos.x, top: pos.y };

  const isStreaming = busy && msgs.at(-1)?.role === 'assistant';

  return (
    <>
      <style>{CSS}</style>
      <div className={`aw-panel ${widgetState}`} style={panelStyle}>

        {/* Header / drag handle */}
        <div className="aw-header" onMouseDown={onDragStart}>
          <span className="aw-title">🤖 {branding.assistant_name}</span>
          {busy && (
            <button
              className="aw-hbtn"
              onClick={() => { abortRef.current?.abort(); }}
              title="Остановить"
            >⏹</button>
          )}
          <button
            className="aw-hbtn"
            onClick={() => setWidgetState(s => s === 'fullscreen' ? 'expanded' : 'fullscreen')}
            title={widgetState === 'fullscreen' ? 'Свернуть' : 'Полный экран'}
          >
            {widgetState === 'fullscreen' ? '⊡' : '⊞'}
          </button>
          <button className="aw-hbtn" onClick={() => setWidgetState('collapsed')} title="Закрыть">✕</button>
        </div>

        {/* Context hint */}
        <div className="aw-hint">{location.pathname} · {detectMode()} mode</div>

        {/* Messages */}
        <div className="aw-messages">
          {msgs.length === 0 && (
            <div className="aw-msg system">Привет! Чем могу помочь?</div>
          )}
          {msgs.map((m, i) => {
            const streaming = isStreaming && i === msgs.length - 1 && m.role === 'assistant';
            return (
              <div key={i} className={`aw-msg ${m.role}${streaming ? ' streaming' : ''}`}>
                {m.text}
                {streaming && <span className="aw-cursor">▌</span>}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="aw-input-row">
          <textarea
            className="aw-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Напишите… (Enter — отправить, Shift+Enter — перенос)"
            rows={1}
            disabled={busy}
            autoFocus={widgetState !== 'collapsed'}
          />
          <button className="aw-send" onClick={send} disabled={busy || !input.trim()}>
            {busy ? '…' : '→'}
          </button>
        </div>
      </div>
    </>
  );
}
