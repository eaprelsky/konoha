import { useState, useEffect, useRef } from 'react';
import type React from 'react';
import { api } from '../../api/client';
import type { Agent, Skill } from '../../api/types';
import { AgentSettingsTab } from './AgentSettingsTab';
import { AgentMemoryTab } from './AgentMemoryTab';

interface EditAgentModalProps { agent: Agent; onClose: () => void; onSaved: () => void; }

export function EditAgentModal({ agent, onClose, onSaved }: EditAgentModalProps) {
  const [tab, setTab] = useState<'settings' | 'memory'>('settings');
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model || 'claude:claude-sonnet-4-6');
  const [prompt, setPrompt] = useState((agent as any).system_prompt || '');
  const [sysTemplate, setSysTemplate] = useState<string | null>(null);
  const [sysExpanded, setSysExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>((agent as any).capabilities || []);
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>((agent as any).avatar_url);
  const [avatarMode, setAvatarMode] = useState<'upload' | 'generate' | 'img2img'>('generate');
  const [avatarStyle, setAvatarStyle] = useState('anime ninja');
  const [avatarPrompt, setAvatarPrompt] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [gender, setGender] = useState<'male' | 'female' | 'neutral'>((agent as any).gender || 'neutral');
  const avatarFileRef = useRef<HTMLInputElement>(null);
  const avatarImg2ImgRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.agents.get(agent.id).then(d => {
      setPrompt((d as any).system_prompt || '');
      setCapabilities((d as any).capabilities || []);
      setAvatarUrl((d as any).avatar_url);
    }).catch(() => {});
    api.agents.systemTemplate(agent.id).then(d => setSysTemplate(d.template)).catch(() => {});
    api.skills.list().then(setAllSkills).catch(() => {});
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  function toggleCapability(id: string) {
    setCapabilities(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  async function doAvatarAction() {
    setGeneratingAvatar(true); setError(null);
    try {
      if (avatarMode === 'upload') {
        avatarFileRef.current?.click();
        setGeneratingAvatar(false);
        return;
      }
      if (avatarMode === 'generate') {
        const res = await api.agents.generateAvatar(agent.id, {
          style: avatarStyle,
          prompt: avatarPrompt || undefined,
          description: prompt.slice(0, 100) || undefined,
        });
        setAvatarUrl(res.avatar_url);
      } else if (avatarMode === 'img2img') {
        if (!avatarFile) { setError('Выберите фото для img2img'); return; }
        const res = await api.agents.generateAvatarImg2Img(agent.id, avatarFile, avatarPrompt || `Portrait avatar in ${avatarStyle} style`);
        setAvatarUrl(res.avatar_url);
      }
    } catch (e: any) {
      setError(`Аватар: ${e.message}`);
    } finally {
      setGeneratingAvatar(false);
    }
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setGeneratingAvatar(true); setError(null);
    try {
      const res = await api.agents.uploadAvatar(agent.id, file);
      setAvatarUrl(res.avatar_url);
    } catch (e: any) {
      setError(`Аватар: ${e.message}`);
    } finally {
      setGeneratingAvatar(false);
      if (avatarFileRef.current) avatarFileRef.current.value = '';
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      await api.agents.update(agent.id, { name: name.trim(), model, system_prompt: prompt, capabilities, gender });
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 620, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ marginBottom: 12 }}>Изменить агента — {agent.id}</h2>
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #e2e8f0', paddingBottom: 8 }}>
          {(['settings', 'memory'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '5px 14px', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: tab === t ? '#6366f1' : '#f1f5f9', color: tab === t ? 'white' : '#475569',
            }}>
              {t === 'settings' ? 'Настройки' : 'Память'}
            </button>
          ))}
        </div>

        {tab === 'settings' && (
          <AgentSettingsTab
            agentId={agent.id} name={name} setName={setName} model={model} setModel={setModel}
            gender={gender} setGender={setGender} prompt={prompt} setPrompt={setPrompt}
            sysTemplate={sysTemplate} sysExpanded={sysExpanded} setSysExpanded={setSysExpanded}
            avatarUrl={avatarUrl} avatarMode={avatarMode} setAvatarMode={setAvatarMode}
            avatarStyle={avatarStyle} setAvatarStyle={setAvatarStyle}
            avatarPrompt={avatarPrompt} setAvatarPrompt={setAvatarPrompt}
            avatarFile={avatarFile} setAvatarFile={setAvatarFile}
            generatingAvatar={generatingAvatar} allSkills={allSkills}
            capabilities={capabilities} toggleCapability={toggleCapability}
            submitting={submitting} error={error} onClose={onClose}
            onSubmit={handleSubmit} onAvatarAction={doAvatarAction}
            onAvatarUpload={handleAvatarUpload}
            avatarFileRef={avatarFileRef} avatarImg2ImgRef={avatarImg2ImgRef}
          />
        )}
        {tab === 'memory' && (
          <AgentMemoryTab agentId={agent.id} onClose={onClose} />
        )}
      </div>
    </div>
  );
}
