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
import { Maximize2, Minimize2, ChevronDown } from 'lucide-react';
import { Inspector } from './Inspector';
import { useBranding } from '../context/BrandingContext';
import './AssistantWidget.css';

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
              setMsgs(prev => [...prev.slice(0, -1), { role: 'assistant', text: full }]);
            } else if (ev.type === 'parsed' && typeof ev.reply === 'string') {
              setMsgs(prev => [...prev.slice(0, -1), { role: 'assistant', text: ev.reply }]);
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
    const isMobile = window.innerWidth < 768;
    return (
      <>
        <button
          className={`aw-trigger${isMobile ? ' aw-trigger-mobile' : ''}`}
          onClick={() => setWidgetState(isMobile ? 'fullscreen' : 'expanded')}
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

  const isStreaming = busy && msgs[msgs.length - 1]?.role === 'assistant';

  return (
    <>
      <div className={`aw-panel ${widgetState}`} style={panelStyle}>

        {/* Header / drag handle */}
        <div className="aw-header" onMouseDown={onDragStart}>
          {branding.assistant_avatar
            ? <img src={branding.assistant_avatar} alt="" className="aw-avatar" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            : <span className="aw-avatar-fallback">🤖</span>
          }
          <span className="aw-title">{branding.assistant_name}</span>
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
            title={widgetState === 'fullscreen' ? 'Свернуть окно' : 'Полный экран'}
            aria-label={widgetState === 'fullscreen' ? 'Свернуть окно' : 'Полный экран'}
          >
            {widgetState === 'fullscreen' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="aw-hbtn" onClick={() => setWidgetState('collapsed')} title="Скрыть чат" aria-label="Скрыть чат">
            <ChevronDown size={14} />
          </button>
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
            autoFocus
          />
          <button className="aw-send" onClick={send} disabled={busy || !input.trim()}>
            {busy ? '…' : '→'}
          </button>
        </div>
      </div>
    </>
  );
}
