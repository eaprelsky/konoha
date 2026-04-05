import { useState, useEffect, useRef } from 'react';
import type React from 'react';
import { api } from '../api/client';
import { useToken } from '../context/TokenContext';
import type { Person, Skill } from '../api/types';

const styles = `
  .profile-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 2000; display: flex; justify-content: center; align-items: center; }
  .profile-modal { background: white; border-radius: 12px; padding: 32px; width: 480px; max-width: 95vw; max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 40px rgba(0,0,0,.2); }
  .profile-modal h2 { font-size: 20px; font-weight: 700; color: #0f172a; margin-bottom: 24px; }
  .profile-avatar-row { display: flex; gap: 20px; align-items: flex-start; margin-bottom: 24px; }
  .profile-avatar { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 3px solid #e2e8f0; flex-shrink: 0; }
  .profile-avatar-placeholder { width: 80px; height: 80px; border-radius: 50%; background: #6366f1; display: flex; align-items: center; justify-content: center; font-size: 28px; color: white; font-weight: 700; flex-shrink: 0; border: 3px solid #e2e8f0; user-select: none; }
  .profile-avatar-actions { flex: 1; display: flex; flex-direction: column; gap: 8px; }
  .profile-avatar-label { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .05em; }
  .profile-avatar-style { padding: 6px 10px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 13px; font-family: inherit; }
  .profile-avatar-btns { display: flex; gap: 6px; flex-wrap: wrap; }
  .btn-avatar-gen { padding: 6px 12px; background: #6366f1; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-avatar-gen:disabled { opacity: .5; cursor: not-allowed; }
  .btn-avatar-gen:hover:not(:disabled) { background: #4f46e5; }
  .btn-avatar-upload { padding: 6px 12px; background: white; color: #374151; border: 1px solid #d1d5db; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .btn-avatar-upload:hover { background: #f9fafb; }
  .profile-section { font-size: 11px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; margin: 20px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #f1f5f9; }
  .profile-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .profile-field label { font-size: 12px; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: .3px; }
  .profile-field input { padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 14px; font-family: inherit; transition: border-color .15s; }
  .profile-field input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.1); }
  .profile-field input:disabled { background: #f8fafc; color: #94a3b8; cursor: not-allowed; }
  .profile-caps { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0; }
  .cap-chip { padding: 3px 10px; border-radius: 14px; font-size: 12px; cursor: pointer; border: 1px solid; user-select: none; transition: all .1s; }
  .cap-chip.on { background: #ede9fe; color: #4f46e5; border-color: #6366f1; }
  .cap-chip.off { background: white; color: #6b7280; border-color: #e5e7eb; }
  .profile-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 24px; }
  .profile-actions button { padding: 8px 18px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-profile-save { background: #6366f1; color: white; }
  .btn-profile-save:hover { background: #4f46e5; }
  .btn-profile-save:disabled { opacity: .5; cursor: not-allowed; }
  .btn-profile-cancel { background: #f1f5f9; color: #374151; }
  .btn-profile-cancel:hover { background: #e2e8f0; }
  .profile-error { background: #fef2f2; color: #dc2626; padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 14px; border-left: 3px solid #dc2626; }
  .profile-picker { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
  .profile-picker p { font-size: 14px; color: #475569; margin-bottom: 8px; }
  .picker-item { padding: 10px 14px; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 10px; transition: border-color .15s; }
  .picker-item:hover { border-color: #6366f1; background: #fafafe; }
  .picker-avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
  .picker-avatar-ph { width: 36px; height: 36px; border-radius: 50%; background: #6366f1; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; flex-shrink: 0; }
  .picker-name { font-weight: 600; font-size: 14px; color: #1e293b; }
  .picker-pos { font-size: 12px; color: #64748b; }
`;

interface Props {
  onClose: () => void;
}

const PROFILE_PERSON_KEY = 'konoha_profile_person_id';

export function ProfileModal({ onClose }: Props) {
  const token = useToken();

  const [phase, setPhase] = useState<'loading' | 'pick' | 'edit'>('loading');
  const [people, setPeople] = useState<Person[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [person, setPerson] = useState<Person | null>(null);

  const [name, setName] = useState('');
  const [position, setPosition] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>();
  const [avatarMode, setAvatarMode] = useState<'upload' | 'generate' | 'img2img'>('generate');
  const [avatarStyle, setAvatarStyle] = useState('professional photo');
  const [avatarPrompt, setAvatarPrompt] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const img2ImgRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    if (!token) return;
    Promise.all([api.people.list(), api.skills.list()])
      .then(([pl, sl]) => {
        setPeople(pl);
        setSkills(sl);
        const storedId = localStorage.getItem(PROFILE_PERSON_KEY);
        if (storedId) {
          const found = pl.find(p => p.id === storedId);
          if (found) { loadPerson(found); return; }
        }
        setPhase('pick');
      })
      .catch(() => setPhase('pick'));
  }, [token]);

  function loadPerson(p: Person) {
    setPerson(p);
    setName(p.name);
    setPosition(p.position || '');
    setCapabilities(p.capabilities || []);
    setAvatarUrl(p.avatar_url);
    setPhase('edit');
  }

  function pickPerson(p: Person) {
    localStorage.setItem(PROFILE_PERSON_KEY, p.id);
    loadPerson(p);
  }

  function toggleCap(id: string) {
    setCapabilities(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  async function doAvatarAction() {
    if (!person) return;
    if (avatarMode === 'upload') { fileInputRef.current?.click(); return; }
    setGeneratingAvatar(true); setError(null);
    try {
      if (avatarMode === 'generate') {
        const res = await api.people.generateAvatar(person.id, {
          style: avatarStyle,
          prompt: avatarPrompt || undefined,
          description: position || undefined,
        });
        setAvatarUrl(res.avatar_url);
      } else if (avatarMode === 'img2img') {
        if (!avatarFile) { setError('Выберите фото для генерации'); return; }
        const res = await api.people.generateAvatarImg2Img(person.id, avatarFile, avatarPrompt || `Portrait in ${avatarStyle} style`);
        setAvatarUrl(res.avatar_url);
      }
    } catch (e: any) {
      setError(`Ошибка генерации: ${e.message}`);
    } finally {
      setGeneratingAvatar(false);
    }
  }

  async function uploadAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    if (!person || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    setGeneratingAvatar(true); setError(null);
    try {
      const res = await api.people.uploadAvatar(person.id, file);
      setAvatarUrl(res.avatar_url);
    } catch (e: any) {
      setError(`Ошибка загрузки: ${e.message}`);
    } finally {
      setGeneratingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!person || !name.trim()) { setError('Имя обязательно'); return; }
    setSubmitting(true); setError(null);
    try {
      await api.people.save({
        id: person.id,
        name: name.trim(),
        position: position.trim(),
        tg_id: person.tg_id,
        tg_username: person.tg_username,
        email: person.email,
        channel: person.channel,
        capabilities: capabilities.length > 0 ? capabilities : undefined,
        avatar_url: avatarUrl,
      });
      onClose();
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  const initials = name.charAt(0).toUpperCase() || '?';

  return (
    <div className="profile-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <style>{styles}</style>
      <div className="profile-modal">
        {phase === 'loading' && <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>Загрузка…</div>}

        {phase === 'pick' && (
          <>
            <h2>Мой профиль</h2>
            <div className="profile-picker">
              <p>Выберите вашу учётную запись из списка:</p>
              {people.map(p => (
                <div key={p.id} className="picker-item" onClick={() => pickPerson(p)}>
                  {p.avatar_url
                    ? <img src={p.avatar_url} className="picker-avatar" alt="" />
                    : <div className="picker-avatar-ph">{p.name.charAt(0).toUpperCase()}</div>
                  }
                  <div>
                    <div className="picker-name">{p.name}</div>
                    {p.position && <div className="picker-pos">{p.position}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className="profile-actions">
              <button className="btn-profile-cancel" onClick={onClose}>Отмена</button>
            </div>
          </>
        )}

        {phase === 'edit' && person && (
          <form onSubmit={save}>
            <h2>Мой профиль</h2>
            {error && <div className="profile-error">{error}</div>}

            <div className="profile-avatar-row">
              {avatarUrl
                ? <img src={avatarUrl} className="profile-avatar" alt="avatar" />
                : <div className="profile-avatar-placeholder">{initials}</div>
              }
              <div className="profile-avatar-actions">
                <div className="profile-avatar-label">Аватар</div>
                {/* Mode tabs */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
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
                  <div className="profile-avatar-btns">
                    <button type="button" className="btn-avatar-upload" onClick={() => fileInputRef.current?.click()} disabled={generatingAvatar}>
                      {generatingAvatar ? '⏳ Загрузка…' : '📁 Загрузить файл'}
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={uploadAvatar} />
                  </div>
                )}
                {avatarMode === 'generate' && (
                  <>
                    <input type="text" className="profile-avatar-style" value={avatarStyle}
                      onChange={e => setAvatarStyle(e.target.value)}
                      placeholder="professional photo, anime, pixel art…" />
                    <input type="text" className="profile-avatar-style" value={avatarPrompt}
                      onChange={e => setAvatarPrompt(e.target.value)}
                      placeholder="Свой промпт (необязательно)" />
                    <div className="profile-avatar-btns">
                      <button type="button" className="btn-avatar-gen" onClick={doAvatarAction} disabled={generatingAvatar}>
                        {generatingAvatar ? '⏳ Генерация…' : '✨ Сгенерировать'}
                      </button>
                    </div>
                  </>
                )}
                {avatarMode === 'img2img' && (
                  <>
                    <input ref={img2ImgRef} type="file" accept="image/*" style={{ display: 'none' }}
                      onChange={e => setAvatarFile(e.target.files?.[0] || null)} />
                    <button type="button" className="btn-avatar-upload" onClick={() => img2ImgRef.current?.click()}>
                      {avatarFile ? avatarFile.name : '📎 Выбрать фото'}
                    </button>
                    <input type="text" className="profile-avatar-style" value={avatarPrompt}
                      onChange={e => setAvatarPrompt(e.target.value)}
                      placeholder="Описание стиля / изменений" />
                    <input type="text" className="profile-avatar-style" value={avatarStyle}
                      onChange={e => setAvatarStyle(e.target.value)}
                      placeholder="professional photo, anime…" />
                    <div className="profile-avatar-btns">
                      <button type="button" className="btn-avatar-gen" onClick={doAvatarAction} disabled={generatingAvatar || !avatarFile}>
                        {generatingAvatar ? '⏳ Генерация…' : '✨ Из фото'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="profile-section">Основное</div>
            <div className="profile-field">
              <label>Имя *</label>
              <input value={name} onChange={e => setName(e.target.value)} required />
            </div>
            <div className="profile-field">
              <label>Должность</label>
              <input value={position} onChange={e => setPosition(e.target.value)} placeholder="Например: CTO" />
            </div>
            <div className="profile-field">
              <label>Telegram</label>
              <input value={person.tg_username ? `@${person.tg_username}` : String(person.tg_id)} disabled />
            </div>

            {skills.length > 0 && (
              <>
                <div className="profile-section">Навыки</div>
                <div className="profile-caps">
                  {skills.map(s => (
                    <span
                      key={s.id}
                      className={`cap-chip ${capabilities.includes(s.id) ? 'on' : 'off'}`}
                      onClick={() => toggleCap(s.id)}
                    >
                      {s.name || s.id}
                    </span>
                  ))}
                </div>
              </>
            )}

            <div className="profile-actions">
              <button type="button" className="btn-profile-cancel" onClick={onClose}>Отмена</button>
              <button type="submit" className="btn-profile-save" disabled={submitting}>
                {submitting ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
