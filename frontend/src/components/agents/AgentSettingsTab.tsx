import { useRef } from 'react';
import type React from 'react';
import type { Skill } from '../../api/types';

interface AgentSettingsTabProps {
  agentId: string;
  name: string;
  setName: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  gender: 'male' | 'female' | 'neutral';
  setGender: (v: 'male' | 'female' | 'neutral') => void;
  prompt: string;
  setPrompt: (v: string) => void;
  sysTemplate: string | null;
  sysExpanded: boolean;
  setSysExpanded: (v: boolean | ((prev: boolean) => boolean)) => void;
  avatarUrl: string | undefined;
  avatarMode: 'upload' | 'generate' | 'img2img';
  setAvatarMode: (v: 'upload' | 'generate' | 'img2img') => void;
  avatarStyle: string;
  setAvatarStyle: (v: string) => void;
  avatarPrompt: string;
  setAvatarPrompt: (v: string) => void;
  avatarFile: File | null;
  setAvatarFile: (v: File | null) => void;
  generatingAvatar: boolean;
  allSkills: Skill[];
  capabilities: string[];
  toggleCapability: (id: string) => void;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  onAvatarAction: () => void;
  onAvatarUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  avatarFileRef: React.RefObject<HTMLInputElement | null>;
  avatarImg2ImgRef: React.RefObject<HTMLInputElement | null>;
}

export function AgentSettingsTab({
  agentId, name, setName, model, setModel, gender, setGender,
  prompt, setPrompt, sysTemplate, sysExpanded, setSysExpanded,
  avatarUrl, avatarMode, setAvatarMode, avatarStyle, setAvatarStyle,
  avatarPrompt, setAvatarPrompt, avatarFile, setAvatarFile,
  generatingAvatar, allSkills, capabilities, toggleCapability,
  submitting, error, onClose, onSubmit, onAvatarAction, onAvatarUpload,
  avatarFileRef, avatarImg2ImgRef,
}: AgentSettingsTabProps) {
  return (
    <form onSubmit={onSubmit} style={{ overflowY: 'auto', flex: 1 }}>
      {error && <div className="error-banner">{error}</div>}
      {/* Avatar section */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
        <div style={{ flexShrink: 0 }}>
          {avatarUrl
            ? <img src={avatarUrl} alt="avatar" style={{ width: 72, height: 72, borderRadius: 8, objectFit: 'cover', border: '2px solid #e2e8f0' }} />
            : <div style={{ width: 72, height: 72, borderRadius: 8, background: '#6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, color: 'white', fontWeight: 700, border: '2px solid #e2e8f0', userSelect: 'none' }}>
                {name.charAt(0).toUpperCase() || agentId.charAt(0).toUpperCase()}
              </div>
          }
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Аватар</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['upload', 'generate', 'img2img'] as const).map(m => (
              <button key={m} type="button" onClick={() => setAvatarMode(m)} style={{
                padding: '3px 10px', border: '1px solid', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                background: avatarMode === m ? '#6366f1' : 'white',
                color: avatarMode === m ? 'white' : '#475569',
                borderColor: avatarMode === m ? '#6366f1' : '#e2e8f0',
              }}>
                {m === 'upload' ? 'Upload' : m === 'generate' ? 'Generate' : 'From photo'}
              </button>
            ))}
          </div>
          {avatarMode === 'upload' && (
            <>
              <input ref={avatarFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onAvatarUpload} />
              <button type="button" onClick={() => avatarFileRef.current?.click()} disabled={generatingAvatar}
                style={{ padding: '5px 12px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: generatingAvatar ? 0.6 : 1 }}>
                {generatingAvatar ? '⏳ Загрузка…' : '📁 Выбрать файл'}
              </button>
            </>
          )}
          {avatarMode === 'generate' && (
            <>
              <input type="text" value={avatarStyle} onChange={e => setAvatarStyle(e.target.value)}
                placeholder="anime ninja, pixel art, portrait…"
                style={{ padding: '5px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }} />
              <button type="button" onClick={onAvatarAction} disabled={generatingAvatar}
                style={{ padding: '5px 12px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: generatingAvatar ? 0.6 : 1 }}>
                {generatingAvatar ? '⏳ Генерируется…' : '✨ Сгенерировать'}
              </button>
            </>
          )}
          {avatarMode === 'img2img' && (
            <>
              <input ref={avatarImg2ImgRef} type="file" accept="image/*" style={{ display: 'none' }}
                onChange={e => setAvatarFile(e.target.files?.[0] || null)} />
              <button type="button" onClick={() => avatarImg2ImgRef.current?.click()}
                style={{ padding: '5px 10px', background: 'white', color: '#374151', border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                {avatarFile ? avatarFile.name : '📎 Выбрать фото'}
              </button>
              <input type="text" value={avatarPrompt} onChange={e => setAvatarPrompt(e.target.value)}
                placeholder="Описание изменений (стиль, детали…)"
                style={{ padding: '5px 10px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }} />
              <button type="button" onClick={onAvatarAction} disabled={generatingAvatar || !avatarFile}
                style={{ padding: '5px 12px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, opacity: (generatingAvatar || !avatarFile) ? 0.6 : 1 }}>
                {generatingAvatar ? '⏳ Генерируется…' : '✨ Сгенерировать из фото'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Fields */}
      <div className="form-group">
        <label>Имя *</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus />
      </div>
      <div className="form-group">
        <label>Модель</label>
        <select value={model} onChange={e => setModel(e.target.value)}>
          <option value="claude:claude-sonnet-4-6">Claude: Sonnet 4.6</option>
          <option value="claude:claude-haiku-4-5-20251001">Claude: Haiku 4.5</option>
          <option value="claude:claude-opus-4-6">Claude: Opus 4.6</option>
          <option value="codex:gpt-5">Codex: GPT-5</option>
          <option value="codex:o4-mini">Codex: o4-mini</option>
          <option value="cursor:sonnet-4">Cursor: Sonnet 4</option>
          <option value="cursor:sonnet-4-thinking">Cursor: Sonnet 4 Thinking</option>
          <option value="cursor:gpt-5">Cursor: GPT-5</option>
        </select>
      </div>
      <div className="form-group">
        <label>Род</label>
        <select value={gender} onChange={e => setGender(e.target.value as 'male' | 'female' | 'neutral')}>
          <option value="neutral">Средний (они)</option>
          <option value="male">Мужской (он)</option>
          <option value="female">Женский (она)</option>
        </select>
      </div>
      {sysTemplate !== null && (
        <div className="form-group">
          <div
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none', padding: '6px 0' }}
            onClick={() => setSysExpanded(v => !v)}
          >
            <label style={{ cursor: 'pointer', color: '#64748b', marginBottom: 0 }}>Системные инструкции (управляются Konoha)</label>
            <span style={{ fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>{sysExpanded ? '▲ Свернуть' : '▼ Развернуть'}</span>
          </div>
          {sysExpanded && (
            <textarea readOnly value={sysTemplate}
              style={{ minHeight: 160, background: '#f8fafc', color: '#475569', fontFamily: 'monospace', fontSize: 12, resize: 'vertical', border: '1px solid #e2e8f0', cursor: 'default' }}
            />
          )}
        </div>
      )}
      <div className="form-group">
        <label>Пользовательские инструкции</label>
        <textarea placeholder="Роль, специализация, типы задач, поведение..."
          value={prompt} onChange={e => setPrompt(e.target.value)} style={{ minHeight: 180 }} />
      </div>
      {allSkills.length > 0 && (
        <div className="form-group">
          <label>Навыки / Capabilities</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 0' }}>
            {allSkills.map(s => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', border: `1px solid ${capabilities.includes(s.id) ? '#6366f1' : '#ddd'}`, borderRadius: 16, cursor: 'pointer', fontSize: 13, background: capabilities.includes(s.id) ? '#ede9fe' : 'white', color: capabilities.includes(s.id) ? '#4f46e5' : '#374151', userSelect: 'none' }}>
                <input type="checkbox" checked={capabilities.includes(s.id)} onChange={() => toggleCapability(s.id)} style={{ display: 'none' }} />
                {capabilities.includes(s.id) ? '✓ ' : ''}{s.name}
              </label>
            ))}
          </div>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>Prompt snippet навыков инжектируется в CLAUDE.md / AGENTS.md при старте агента</span>
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="btn-cancel-f" onClick={onClose}>Отмена</button>
        <button type="submit" className="btn-submit" disabled={submitting}>{submitting ? 'Сохранение…' : 'Сохранить'}</button>
      </div>
    </form>
  );
}
