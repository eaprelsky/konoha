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

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Maximize2, Minimize2, ChevronDown, Paperclip, X } from 'lucide-react';
import { Inspector } from './Inspector';
import { useBranding } from '../context/BrandingContext';
import { useHighlight } from './HighlightOverlay';
import './AssistantWidget.css';

type WidgetState = 'collapsed' | 'expanded' | 'fullscreen';

interface Msg {
  role: 'user' | 'assistant' | 'system';
  text: string;
  images?: string[]; // data URLs for display
}

interface AttachmentImg {
  data: string;   // base64 without prefix
  mime: string;
  name: string;
  dataUrl: string; // full data URL for preview
}

const POS_KEY = 'konoha_aw_pos';
const SIZE_KEY = 'konoha_aw_size';
const CHAT_KEY = 'konoha_aw_chat_id';


function defaultPos() {
  return { x: Math.max(0, window.innerWidth - 432), y: Math.max(0, window.innerHeight - 532) };
}

function readFileAsAttachment(file: File): Promise<AttachmentImg> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const [prefix, data] = dataUrl.split(',');
      const mime = prefix.replace('data:', '').replace(';base64', '');
      resolve({ data, mime, name: file.name, dataUrl });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Render markdown text to HTML.
 * Handles: **bold**, *italic*, `code`, and newlines.
 * Escapes HTML before applying transforms to prevent XSS.
 */
function renderMarkdown(text: string): string {
  // Escape HTML special chars first
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

/**
 * Extract readable text from a partial/in-progress JSON reply.
 * During SSE streaming the model emits raw JSON fragments like:
 *   {"reply": "Hello, I'm Tsuna...
 * This function strips the wrapper so only the reply value is shown.
 */
function extractStreamingText(raw: string): string {
  const m = raw.match(/"reply"\s*:\s*"([\s\S]*)/);
  if (!m) return raw;
  return m[1]
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}


export function AssistantWidget() {
  const branding = useBranding();
  const { showHighlight } = useHighlight();
  const navigate = useNavigate();
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
  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    try { const s = localStorage.getItem(SIZE_KEY); return s ? JSON.parse(s) : { w: 400, h: 500 }; }
    catch { return { w: 400, h: 500 }; }
  });

  const [attachments, setAttachments] = useState<AttachmentImg[]>([]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // Track CSS resize (native browser resize handle) and persist
  const onSizeChange = useCallback(() => {
    if (!panelRef.current || widgetState === 'fullscreen') return;
    const { offsetWidth: w, offsetHeight: h } = panelRef.current;
    const newSize = { w, h };
    setSize(newSize);
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(newSize)); } catch {}
  }, [widgetState]);

  useEffect(() => {
    if (!panelRef.current) return;
    const ro = new ResizeObserver(onSizeChange);
    ro.observe(panelRef.current);
    return () => ro.disconnect();
  }, [onSizeChange, widgetState]);

  async function addFiles(files: FileList | File[]) {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    const results = await Promise.all(imageFiles.map(readFileAsAttachment));
    setAttachments(prev => [...prev, ...results]);
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const imageItems = Array.from(e.clipboardData.items).filter(it => it.type.startsWith('image/'));
    if (imageItems.length === 0) return;
    e.preventDefault();
    const files = imageItems.map(it => it.getAsFile()).filter(Boolean) as File[];
    addFiles(files);
  }

  function onDragOver(e: React.DragEvent) { e.preventDefault(); }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }

  async function send() {
    const msg = input.trim();
    if (!msg && attachments.length === 0) return;
    if (busy) return;
    setInput('');
    const sentAttachments = attachments;
    setAttachments([]);
    Inspector.trackAction(`assistant: ${msg.slice(0, 60)}`);
    setMsgs(prev => [...prev, {
      role: 'user',
      text: msg,
      images: sentAttachments.length > 0 ? sentAttachments.map(a => a.dataUrl) : undefined,
    }]);
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
          message: msg || '(см. вложения)',
          context,
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
              setMsgs(prev => [...prev.slice(0, -1), { role: 'assistant', text: extractStreamingText(full) }]);
            } else if (ev.type === 'parsed') {
              // Update message text (reply might be null if only a schema_patch was returned)
              const replyText = typeof ev.reply === 'string' ? ev.reply : null;
              setMsgs(prev => {
                const msgs = replyText != null
                  ? [...prev.slice(0, -1), { role: 'assistant' as const, text: replyText }]
                  : [...prev];
                // Notify user that schema was updated
                if (ev.schema_patch || ev.created_workflow) {
                  msgs.push({ role: 'system' as const, text: 'Схема обновлена. Нажмите 💾 для сохранения.' });
                }
                return msgs;
              });
              // Dispatch DOM events so ProcessEditor can apply the patch (decoupled from reply presence)
              if (ev.schema_patch) {
                window.dispatchEvent(new CustomEvent('konoha:schema_patch', { detail: ev.schema_patch }));
              }
              if (ev.created_workflow) {
                window.dispatchEvent(new CustomEvent('konoha:workflow_created', { detail: ev.created_workflow }));
                // If ProcessEditor is not currently mounted, navigate to it (#428)
                if (!window.location.pathname.includes('/editor')) {
                  navigate(`/editor/${ev.created_workflow.id}`);
                }
              }
              if (Array.isArray(ev.actions) && ev.actions.length > 0) {
                const act = ev.actions[0];
                if (act.type === 'highlight' && act.target) {
                  showHighlight({ selector: act.target, style: act.style ?? 'spotlight', message: act.message });
                }
              }
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
    if (e.key === 'Escape') { setAttachments([]); }
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
    widgetState === 'fullscreen' ? {} : { left: pos.x, top: pos.y, width: size.w, height: size.h };

  const isStreaming = busy && msgs[msgs.length - 1]?.role === 'assistant';

  return (
    <>
      <div ref={panelRef} className={`aw-panel ${widgetState}`} style={panelStyle}
        onDragOver={onDragOver} onDrop={onDrop}>

        {/* Header / drag handle */}
        <div className="aw-header" onMouseDown={onDragStart}>
          {branding.assistant_agent_id
            ? <img src={`/api/avatars/${branding.assistant_agent_id}.webp`} alt="" className="aw-avatar" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            : <span className="aw-avatar-fallback">🤖</span>
          }
          <span className="aw-title">{branding.agent_display_names[branding.assistant_agent_id] || branding.assistant_agent_id || 'Ассистент'}</span>
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


        {/* Messages */}
        <div className="aw-messages">
          {msgs.length === 0 && (
            <div className="aw-msg system">Привет! Чем могу помочь?</div>
          )}
          {msgs.map((m, i) => {
            const streaming = isStreaming && i === msgs.length - 1 && m.role === 'assistant';
            return (
              <div key={i} className={`aw-msg ${m.role}${streaming ? ' streaming' : ''}`}>
                {m.images && m.images.length > 0 && (
                  <div className="aw-msg-images">
                    {m.images.map((src, j) => (
                      <img key={j} src={src} className="aw-msg-img" alt="вложение" />
                    ))}
                  </div>
                )}
                {m.role === 'assistant'
                  ? <span dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
                  : m.text}
                {streaming && <span className="aw-cursor">▌</span>}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Attachment preview strip */}
        {attachments.length > 0 && (
          <div className="aw-attachments">
            {attachments.map((att, i) => (
              <div key={i} className="aw-att-thumb">
                <img src={att.dataUrl} alt={att.name} />
                <button className="aw-att-remove" title="Удалить" onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}>
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="aw-input-row">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={onFileInput}
          />
          <button
            className="aw-attach-btn"
            title="Прикрепить изображение (или перетащите / Ctrl+V)"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            <Paperclip size={14} />
          </button>
          <textarea
            className="aw-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={"Напишите…\n(Enter — отправить, Shift+Enter — перенос)"}
            rows={2}
            disabled={busy}
            autoFocus
          />
          <button className="aw-send" onClick={send} disabled={busy || (!input.trim() && attachments.length === 0)}>
            {busy ? '…' : '→'}
          </button>
        </div>
      </div>
    </>
  );
}
