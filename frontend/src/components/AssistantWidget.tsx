/**
 * AssistantWidget — floating AI assistant panel (closes #293)
 *
 * - position: fixed, z-index 9999, outside router (no remounts)
 * - Draggable (position persisted in localStorage)
 * - 3 states: collapsed → expanded → fullscreen
 * - Ctrl+/ toggles open/close
 * - SSE streaming via POST /api/ai/chat
 * - Inspector context auto-attached to every request
 *
 * Decomposed (issue #448):
 *  - useAssistantChat.ts   — chat state, SSE streaming, send/abort
 *  - useWidgetPosition.ts  — drag, resize, position/size persistence
 */

import { useState, useRef, useEffect } from 'react';
import { Maximize2, Minimize2, ChevronDown, Paperclip, X } from 'lucide-react';
import { useBranding } from '../context/BrandingContext';
import { useAssistantChat, type AttachmentImg } from '../hooks/useAssistantChat';
import { useWidgetPosition } from '../hooks/useWidgetPosition';
import './AssistantWidget.css';

type WidgetState = 'collapsed' | 'expanded' | 'fullscreen';

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

function renderMarkdown(text: string): string {
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

export function AssistantWidget() {
  const branding = useBranding();
  const [widgetState, setWidgetState] = useState<WidgetState>('collapsed');
  const { msgs, input, setInput, busy, attachments, setAttachments, send, abort, pendingConfirmations, confirmAction, cancelAction, sessions, currentSession, sessionsLoading, newSession, switchSession, archiveSession: archiveSessionAction, deleteSession: deleteSessionAction } = useAssistantChat();
  const [showSessions, setShowSessions] = useState(false);
  const { pos, size, isMobile, mobileHeight, panelRef, onDragStart, onHandleTouchStart, onHandleTouchMove, onHandleTouchEnd } = useWidgetPosition(widgetState === 'fullscreen');

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcuts
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

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

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
    addFiles(imageItems.map(it => it.getAsFile()).filter(Boolean) as File[]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape') { setAttachments(() => []); }
  }

  if (widgetState === 'collapsed') {
    return (
      <button
        className={`aw-trigger${isMobile ? ' aw-trigger-mobile' : ''}`}
        onClick={() => setWidgetState('expanded')}
        title="Ассистент (Ctrl+/)"
      >
        💬
      </button>
    );
  }

  const panelStyle: React.CSSProperties =
    widgetState === 'fullscreen' ? {}
    : isMobile ? { height: mobileHeight }
    : { left: pos.x, top: pos.y, width: size.w, height: size.h };

  const isStreaming = busy && msgs[msgs.length - 1]?.role === 'assistant';

  return (
    <>
      <div ref={panelRef} className={`aw-panel ${widgetState}`} style={panelStyle}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); if (e.dataTransfer.files) addFiles(e.dataTransfer.files); }}>

        <div className="aw-drag-handle" onTouchStart={onHandleTouchStart} onTouchMove={onHandleTouchMove} onTouchEnd={onHandleTouchEnd}>
          <div className="aw-drag-handle-pill" />
        </div>

        <div className="aw-header" onMouseDown={onDragStart}>
          {branding.assistant_agent_id
            ? <img src={`/api/avatars/${branding.assistant_agent_id}.webp`} alt="" className="aw-avatar" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            : <span className="aw-avatar-fallback">🤖</span>
          }
          <span className="aw-title">{branding.agent_display_names[branding.assistant_agent_id] || branding.assistant_agent_id || 'Ассистент'}</span>
          {busy && <button className="aw-hbtn" onClick={abort} title="Остановить">⏹</button>}
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

        {/* Session bar */}
        <div className="aw-session-bar">
          <button
            className="aw-session-current"
            onClick={() => setShowSessions(s => !s)}
            title="Темы / сессии"
          >
            <span className="aw-session-icon">💬</span>
            <span className="aw-session-title">
              {currentSession?.title ?? 'Новая тема'}
            </span>
            <span className="aw-session-chevron">{showSessions ? '▴' : '▾'}</span>
          </button>
          {!currentSession && (
            <button className="aw-session-new-btn" onClick={newSession} title="Новая тема">+</button>
          )}
          {showSessions && (
            <div className="aw-session-dropdown">
              <button className="aw-session-item aw-session-new" onClick={() => { newSession(); setShowSessions(false); }}>
                <span>➕ Новая тема</span>
              </button>
              {sessionsLoading && <div className="aw-session-item" style={{ color: '#64748b', fontSize: 11 }}>Загрузка…</div>}
              {!sessionsLoading && sessions.length === 0 && (
                <div className="aw-session-item" style={{ color: '#64748b', fontSize: 11 }}>Нет активных тем</div>
              )}
              {sessions.map(s => (
                <div key={s.chat_id} className={`aw-session-item${s.chat_id === (currentSession?.chat_id ?? '') ? ' active' : ''}`}>
                  <button
                    className="aw-session-item-btn"
                    onClick={() => { switchSession(s.chat_id); setShowSessions(false); }}
                  >
                    <span className="aw-session-item-title">{s.title}</span>
                    {s.last_message && (
                      <span className="aw-session-item-last">{s.last_message}</span>
                    )}
                  </button>
                  <button
                    className="aw-session-item-archive"
                    onClick={(e) => { e.stopPropagation(); archiveSessionAction(s.chat_id); }}
                    title="Архивировать"
                  >
                    📦
                  </button>
                  <button
                    className="aw-session-item-delete"
                    onClick={(e) => { e.stopPropagation(); deleteSessionAction(s.chat_id); }}
                    title="Удалить"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="aw-messages">
          {msgs.length === 0 && <div className="aw-msg system">Привет! Чем могу помочь?</div>}
          {msgs.map((m, i) => {
            const streaming = isStreaming && i === msgs.length - 1 && m.role === 'assistant';
            return (
              <div key={i} className={`aw-msg ${m.role}${streaming ? ' streaming' : ''}`}>
                {m.images && m.images.length > 0 && (
                  <div className="aw-msg-images">
                    {m.images.map((src, j) => <img key={j} src={src} className="aw-msg-img" alt="вложение" />)}
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

        {pendingConfirmations.filter(c => c.status === 'required').length > 0 && (
          <div className="aw-confirmations">
            {pendingConfirmations.filter(c => c.status === 'required').map(c => (
              <div key={c.id} className="aw-confirmation-item">
                <span className="aw-confirmation-label">
                  {c.action === 'workflow.delete' ? 'Удаление процесса' :
                   c.action === 'workflow.create' ? 'Создание процесса' :
                   c.action === 'case.start' ? 'Запуск процесса' :
                   c.action}
                </span>
                <div className="aw-confirmation-buttons">
                  <button
                    className="aw-confirm-btn"
                    onClick={() => confirmAction(c.id)}
                    title="Подтвердить"
                  >
                    ✓ Подтвердить
                  </button>
                  <button
                    className="aw-cancel-btn"
                    onClick={() => cancelAction(c.id)}
                    title="Отменить"
                  >
                    ✕ Отмена
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

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

        <div className="aw-input-row">
          <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onFileInput} />
          <button className="aw-attach-btn" title="Прикрепить изображение (или перетащите / Ctrl+V)" onClick={() => fileInputRef.current?.click()} disabled={busy}>
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
