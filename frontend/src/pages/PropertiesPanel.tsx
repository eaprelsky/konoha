/**
 * PropertiesPanel — sidebar element properties editor.
 * Extracted from ProcessEditor.tsx (issue #330).
 */
import type { WorkflowElement, RoleDef, DocTemplate } from '../api/types';

type TriggerKind = NonNullable<WorkflowElement['trigger']>['kind'];
type TriggerType = NonNullable<WorkflowElement['trigger']>['type'];

interface Props {
  selEl: WorkflowElement;
  flow: [string, string, string?][];
  roles: RoleDef[];
  docs: DocTemplate[];
  wsFiles: string[];
  wfId: string;
  onUpdate: (id: string, patch: Partial<WorkflowElement>) => void;
  onDelete: (id: string) => void;
}

export function PropertiesPanel({ selEl, flow, roles, docs, wsFiles, wfId, onUpdate, onDelete }: Props) {
  const isStartEvent = selEl.type === 'event' && !flow.some(([, to]) => to === selEl.id);

  return (
    <div>
      <h3>Свойства</h3>

      <div className="props-field">
        <label>Название</label>
        <input value={selEl.label} onChange={e => onUpdate(selEl.id, { label: e.target.value })} />
      </div>

      {selEl.type === 'gateway' && (
        <div className="props-field">
          <label>Оператор</label>
          <select value={selEl.operator || 'AND'} onChange={e => onUpdate(selEl.id, { operator: e.target.value })}>
            <option>AND</option><option>OR</option><option>XOR</option>
          </select>
        </div>
      )}

      {selEl.type === 'function' && (
        <>
          <div className="props-field">
            <label>Роль</label>
            {roles.length > 0 ? (
              <select value={selEl.role || ''} onChange={e => onUpdate(selEl.id, { role: e.target.value || undefined })}>
                <option value="">— нет —</option>
                {roles.map(r => <option key={r.role_id} value={r.name}>{r.name}</option>)}
                {selEl.role && !roles.some(r => r.name === selEl.role) &&
                  <option value={selEl.role}>{selEl.role}</option>}
              </select>
            ) : (
              <input value={selEl.role || ''} placeholder="Назначенная роль…"
                onChange={e => onUpdate(selEl.id, { role: e.target.value || undefined })} />
            )}
          </div>
          <div className="props-field">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <label style={{ margin: 0 }}>Намерение (Intent)</label>
              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 8, background: selEl.intent ? '#065f46' : '#1e293b', color: selEl.intent ? '#6ee7b7' : '#94a3b8', fontWeight: 600 }}>
                {selEl.intent ? 'intent' : 'instruction'}
              </span>
            </div>
            <textarea
              value={selEl.intent || ''}
              onChange={e => onUpdate(selEl.id, { intent: e.target.value || undefined })}
              placeholder="Опишите цель/результат (не инструкцию)."
              rows={3}
              style={{ width: '100%', padding: '5px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 12, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
            />
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
              Если задан — AI-агент получает цель вместо инструкции.
            </div>
          </div>
        </>
      )}

      {isStartEvent && (
        <TriggerSection selEl={selEl} wfId={wfId} onUpdate={onUpdate} />
      )}

      {selEl.type === 'document' && (
        <DocumentSection selEl={selEl} wsFiles={wsFiles} onUpdate={onUpdate} />
      )}

      <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace', marginBottom: 4 }}>{selEl.id}</div>
      {selEl.locked && (
        <div style={{ fontSize: 11, color: '#f59e0b', padding: '4px 8px', background: '#451a03', borderRadius: 4, marginBottom: 6 }}>
          🔒 Граничное событие — заблокировано
        </div>
      )}
      {!selEl.locked && (
        <button className="btn-del-el" onClick={() => onDelete(selEl.id)}>Удалить элемент</button>
      )}
    </div>
  );
}

// ── Trigger section (start event) ─────────────────────────────────────────────

function TriggerSection({ selEl, wfId, onUpdate }: { selEl: WorkflowElement; wfId: string; onUpdate: (id: string, patch: Partial<WorkflowElement>) => void }) {
  const tr = selEl.trigger;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.05em', margin: '14px 0 8px', paddingBottom: 4, borderBottom: '1px solid #f1f5f9' }}>Триггер запуска</div>

      {(!tr || (!tr.kind && !tr.type)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 6, marginBottom: 10, fontSize: 12, color: '#92400e' }}>
          <span>⚠</span> Триггер не определён — процесс не может быть запущен автоматически
        </div>
      )}

      {tr?.confidence !== undefined && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', marginBottom: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12 }}>
          <span style={{ fontSize: 10 }}>Уверенность:</span>
          {(() => {
            const c = tr.confidence!;
            const color = c >= 0.9 ? '#22c55e' : c >= 0.7 ? '#f59e0b' : '#ef4444';
            const label = c >= 0.9 ? 'высокая' : c >= 0.7 ? 'средняя' : 'низкая';
            return (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' }} />
                <strong style={{ color }}>{Math.round(c * 100)}%</strong>
                <span style={{ color: '#64748b' }}>({label})</span>
              </span>
            );
          })()}
        </div>
      )}

      {tr?.mode === 'manual' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, marginBottom: 10, fontSize: 12, color: '#0369a1' }}>
          <span>👁</span> Отслеживается вручную — адаптер для источника не зарегистрирован
        </div>
      )}

      {tr?.manual_override && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 6, marginBottom: 10, fontSize: 12, color: '#92400e' }}>
          <span>🔒</span>
          <span style={{ flex: 1 }}>Триггер задан вручную</span>
          <button
            style={{ padding: '2px 8px', fontSize: 11, border: '1px solid #fbbf24', borderRadius: 4, background: 'white', cursor: 'pointer', color: '#92400e', whiteSpace: 'nowrap' }}
            onClick={() => onUpdate(selEl.id, { trigger: { ...tr, manual_override: false } })}
          >
            Сбросить на авто
          </button>
        </div>
      )}

      {tr?.kind === 'ambiguous' && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '10px 12px', marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#991b1b', marginBottom: 8 }}>⚠ Неоднозначный триггер — выберите вариант</div>
          {(tr.candidates ?? []).map((c, i) => {
            const confColor = c.confidence >= 0.9 ? '#22c55e' : c.confidence >= 0.7 ? '#f59e0b' : '#ef4444';
            return (
              <button key={i}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 10px', marginBottom: 4, background: 'white', border: '1px solid #fca5a5', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                onClick={() => onUpdate(selEl.id, { trigger: { ...tr, kind: c.kind as TriggerKind, confidence: c.confidence, candidates: undefined, manual_override: true } })}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: confColor, display: 'inline-block', flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{c.description}</span>
                <span style={{ color: confColor, fontWeight: 600 }}>{Math.round(c.confidence * 100)}%</span>
              </button>
            );
          })}
          <div style={{ marginTop: 6, fontSize: 11, color: '#9ca3af' }}>— или введите кастомный тип триггера ниже —</div>
          <input
            style={{ width: '100%', marginTop: 4, padding: '4px 8px', border: '1px solid #fca5a5', borderRadius: 4, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
            placeholder="Кастомный тип, например: timer, message, condition…"
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                const val = (e.target as HTMLInputElement).value.trim();
                onUpdate(selEl.id, { trigger: { ...tr, kind: val as TriggerKind, candidates: undefined, manual_override: true } });
              }
            }}
          />
        </div>
      )}

      <div className="props-field">
        <label>Тип триггера</label>
        <select
          value={tr?.type || 'manual'}
          onChange={e => onUpdate(selEl.id, { trigger: { ...tr, type: e.target.value as TriggerType, manual_override: true } })}
        >
          <option value="manual">Manual — кнопка / API</option>
          <option value="webhook">Webhook — HTTP POST</option>
          <option value="schedule">Schedule — расписание</option>
          <option value="telegram">Telegram — входящее сообщение</option>
          <option value="event">Event — завершение другого процесса</option>
        </select>
      </div>

      {tr?.type === 'webhook' && (
        <div className="props-field">
          <label>URL вебхука</label>
          <input readOnly value={`POST /trigger/${wfId || '<process_id>'}`}
            style={{ background: '#f8fafc', fontFamily: 'monospace', fontSize: 12, color: '#475569' }}
            onClick={e => (e.target as HTMLInputElement).select()} />
          <span style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, display: 'block' }}>Тело: {"{ subject, payload }"}</span>
        </div>
      )}
      {tr?.type === 'schedule' && (
        <div className="props-field">
          <label>Cron-выражение</label>
          <input value={tr?.cron || ''} onChange={e => onUpdate(selEl.id, { trigger: { ...tr, type: 'schedule', cron: e.target.value } })} placeholder="0 9 * * MON" />
          <span style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, display: 'block' }}>Пример: 0 9 * * 1-5 — каждый будний день в 9:00</span>
        </div>
      )}
      {tr?.type === 'telegram' && (
        <>
          <div className="props-field">
            <label>Chat ID</label>
            <input value={tr?.chat_id || ''} onChange={e => onUpdate(selEl.id, { trigger: { ...tr, type: 'telegram', chat_id: e.target.value } })} placeholder="Числовой ID чата" />
          </div>
          <div className="props-field">
            <label>Ключевое слово (опционально)</label>
            <input value={tr?.keyword || ''} onChange={e => onUpdate(selEl.id, { trigger: { ...tr, type: 'telegram', keyword: e.target.value } })} placeholder="Фильтр по тексту сообщения" />
          </div>
        </>
      )}
      {tr?.type === 'event' && (
        <div className="props-field">
          <label>Тип события</label>
          <input value={tr?.event_type || ''} onChange={e => onUpdate(selEl.id, { trigger: { ...tr, type: 'event', event_type: e.target.value } })} placeholder="Например: lead.qualified" />
        </div>
      )}
    </div>
  );
}

// ── Document section ──────────────────────────────────────────────────────────

function DocumentSection({ selEl, wsFiles, onUpdate }: { selEl: WorkflowElement; wsFiles: string[]; onUpdate: (id: string, patch: Partial<WorkflowElement>) => void }) {
  return (
    <>
      <div className="props-field">
        <label>Тип документа</label>
        <select
          value={selEl.content_type || 'instruction'}
          onChange={e => onUpdate(selEl.id, { content_type: e.target.value as 'instruction' | 'file', content: undefined, file_ref: undefined })}
        >
          <option value="instruction">Инструкция (текст)</option>
          <option value="file">Файл из Workspace</option>
        </select>
      </div>
      {(selEl.content_type || 'instruction') === 'instruction' && (
        <div className="props-field">
          <label>Содержание</label>
          <textarea
            value={selEl.content || ''}
            onChange={e => onUpdate(selEl.id, { content: e.target.value || undefined })}
            placeholder="Текст инструкции для исполнителя…"
            rows={6}
            style={{ width: '100%', padding: '6px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </div>
      )}
      {selEl.content_type === 'file' && (
        <div className="props-field">
          <label>Файл</label>
          {wsFiles.length > 0 ? (
            <select value={selEl.file_ref || ''} onChange={e => onUpdate(selEl.id, { file_ref: e.target.value || undefined })}>
              <option value="">— выбрать файл —</option>
              {wsFiles.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          ) : (
            <span style={{ fontSize: 12, color: '#94a3b8' }}>Нет файлов в Workspace</span>
          )}
          {selEl.file_ref && (
            <span style={{ fontSize: 11, color: '#64748b', marginTop: 4, display: 'block' }}>/opt/shared/workspace/{selEl.file_ref}</span>
          )}
        </div>
      )}
    </>
  );
}
