/**
 * TriggerPopup — click popup on event node showing full trigger descriptor,
 * confidence, and manual override controls. Issue #412.
 */
import { useState } from 'react';
import type { WorkflowElement } from '../api/types';

type Trigger = NonNullable<WorkflowElement['trigger']>;
type TriggerKind = Trigger['kind'];

const KIND_OPTIONS: { value: TriggerKind; label: string }[] = [
  { value: 'timer',       label: '⏱ timer — периодическое событие' },
  { value: 'message',     label: '✉ message — входящее сообщение' },
  { value: 'condition',   label: '⚡ condition — условие по данным' },
  { value: 'delay_after', label: '⏳ delay — отложенное событие' },
  { value: 'manual',      label: '👤 manual — действие человека' },
  { value: 'system',      label: '⚙ system — внутреннее событие движка' },
];

interface Props {
  el: WorkflowElement;
  posX: number;
  posY: number;
  zoom: number;
  panX: number;
  panY: number;
  onUpdate: (id: string, patch: Partial<WorkflowElement>) => void;
  onClose: () => void;
}

/** Convert world coords to SVG foreign-object coords (inside the transform group) */
function worldPos(posX: number, posY: number, elW: number) {
  const POPUP_W = 260;
  // Place to the right of the element; clamp roughly
  return { x: posX + elW + 8, y: posY - 20 };
}

export function TriggerPopup({ el, posX, posY, zoom: _z, panX: _px, panY: _py, onUpdate, onClose }: Props) {
  const tr = el.trigger;
  const [overrideKind, setOverrideKind] = useState<TriggerKind>(tr?.kind ?? 'manual');

  const POPUP_W = 260;
  const { x, y } = worldPos(posX, posY, 160);

  function applyOverride() {
    onUpdate(el.id, { trigger: { ...tr, kind: overrideKind, manual_override: true, confidence: 1 } });
    onClose();
  }

  function resetOverride() {
    const { manual_override: _, ...rest } = tr ?? {};
    onUpdate(el.id, { trigger: { ...rest, confidence: undefined } });
    onClose();
  }

  return (
    <foreignObject x={x} y={y} width={POPUP_W} height={320} style={{ overflow: 'visible' }}>
      {/* @ts-ignore xmlns needed for SVG foreignObject */}
      <div xmlns="http://www.w3.org/1999/xhtml" style={{
        background: '#1e293b',
        border: '1px solid #334155',
        borderRadius: 8,
        boxShadow: '0 12px 32px rgba(0,0,0,.5)',
        padding: '12px 14px',
        width: POPUP_W,
        fontSize: 12,
        color: '#e2e8f0',
        fontFamily: 'system-ui,-apple-system,sans-serif',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>Триггер: {el.label || el.id}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>

        {/* Current state */}
        {tr && (tr.kind || tr.type) ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ color: '#94a3b8', fontSize: 11 }}>Тип:</span>
              <span style={{ fontWeight: 600, color: '#93c5fd' }}>{tr.kind ?? tr.type}</span>
              {tr.confidence != null && (
                <span style={{
                  padding: '1px 6px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                  background: tr.confidence > 0.8 ? '#14532d' : tr.confidence > 0.5 ? '#78350f' : '#7f1d1d',
                  color: tr.confidence > 0.8 ? '#86efac' : tr.confidence > 0.5 ? '#fde68a' : '#fca5a5',
                }}>
                  {Math.round(tr.confidence * 100)}%
                </span>
              )}
              {tr.manual_override && <span style={{ color: '#f59e0b', fontSize: 10 }}>🔒 вручную</span>}
            </div>

            {/* Ambiguous candidates */}
            {tr.kind === 'ambiguous' && tr.candidates && tr.candidates.length > 0 && (
              <div style={{ background: '#0f172a', borderRadius: 4, padding: '6px 8px', marginBottom: 6 }}>
                <div style={{ color: '#94a3b8', fontSize: 10, marginBottom: 4 }}>Варианты:</div>
                {tr.candidates.map(c => (
                  <div key={c.kind} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 11 }}>
                    <span style={{ color: '#cbd5e1' }}>{c.kind}</span>
                    <span style={{ color: '#64748b' }}>{Math.round(c.confidence * 100)}%</span>
                  </div>
                ))}
              </div>
            )}

            {/* JSON descriptor (collapsed) */}
            <details style={{ marginBottom: 4 }}>
              <summary style={{ cursor: 'pointer', color: '#64748b', fontSize: 10, userSelect: 'none' }}>JSON дескриптор</summary>
              <pre style={{ background: '#0f172a', borderRadius: 4, padding: '6px 8px', fontSize: 10, color: '#94a3b8', overflowX: 'auto', margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(tr, null, 2)}
              </pre>
            </details>
          </div>
        ) : (
          <div style={{ color: '#64748b', fontSize: 11, marginBottom: 10 }}>Триггер не определён автоматически.</div>
        )}

        {/* Override */}
        <div style={{ borderTop: '1px solid #334155', paddingTop: 10 }}>
          <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 6 }}>Переопределить тип вручную:</div>
          <select
            value={overrideKind ?? ''}
            onChange={e => setOverrideKind(e.target.value as TriggerKind)}
            style={{ width: '100%', padding: '5px 8px', background: '#0f172a', border: '1px solid #334155', borderRadius: 4, color: '#e2e8f0', fontSize: 12, marginBottom: 8 }}
          >
            {KIND_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={applyOverride} style={{ flex: 1, padding: '5px 0', background: '#1d4ed8', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
              Применить
            </button>
            {tr?.manual_override && (
              <button onClick={resetOverride} style={{ padding: '5px 10px', background: '#374151', color: '#d1d5db', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                Сбросить
              </button>
            )}
          </div>
        </div>
      </div>
    </foreignObject>
  );
}
