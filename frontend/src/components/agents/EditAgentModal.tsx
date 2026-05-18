import { useState, useEffect, useRef } from 'react';
import type React from 'react';
import { api } from '../../api/client';
import type { Agent, Skill } from '../../api/types';
import { AgentSettingsTab } from './AgentSettingsTab';
import { AgentMemoryTab } from './AgentMemoryTab';
import { useI18n } from '../../context/I18nContext';

interface EditAgentModalProps { agent: Agent; onClose: () => void; onSaved: () => void; }
type EditableAgentSnapshot = {
  name: string;
  display_alias: string;
  runtime: string;
  fallback_runtime: string;
  model: string;
  reasoning_effort: string;
  system_prompt: string;
  capabilities: string[];
  gender: 'male' | 'female' | 'neutral';
};

function snapshotFromAgent(agent: Agent): EditableAgentSnapshot {
  return {
    name: agent.name,
    display_alias: agent.display_alias || '',
    runtime: (agent as any).runtime || '',
    fallback_runtime: (agent as any).fallback_runtime || '',
    model: agent.model || '',
    reasoning_effort: (agent as any).reasoning_effort || '',
    system_prompt: (agent as any).system_prompt || '',
    capabilities: [...((agent as any).capabilities || [])],
    gender: (agent as any).gender || 'neutral',
  };
}

function sameStringArray(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function buildAgentUpdatePatch(initial: EditableAgentSnapshot, current: EditableAgentSnapshot) {
  const patch: {
    name?: string;
    display_alias?: string;
    runtime?: string;
    fallback_runtime?: string;
    model?: string;
    reasoning_effort?: string;
    system_prompt?: string;
    capabilities?: string[];
    gender?: string;
  } = {};

  const name = current.name.trim();
  const displayAlias = current.display_alias.trim();
  if (name !== initial.name) patch.name = name;
  if (displayAlias !== initial.display_alias) patch.display_alias = displayAlias || undefined;
  if (current.runtime !== initial.runtime) patch.runtime = current.runtime;
  if (current.fallback_runtime !== initial.fallback_runtime) patch.fallback_runtime = current.fallback_runtime || undefined;
  if (current.model !== initial.model) patch.model = current.model;
  if (current.reasoning_effort !== initial.reasoning_effort) patch.reasoning_effort = current.reasoning_effort || undefined;
  if (current.system_prompt !== initial.system_prompt) patch.system_prompt = current.system_prompt;
  if (!sameStringArray(current.capabilities, initial.capabilities)) patch.capabilities = current.capabilities;
  if (current.gender !== initial.gender) patch.gender = current.gender;
  return patch;
}

export function EditAgentModal({ agent, onClose, onSaved }: EditAgentModalProps) {
  const { t } = useI18n();
  const initialAgentSnapshot = snapshotFromAgent(agent);
  const [tab, setTab] = useState<'settings' | 'memory'>('settings');
  const [name, setName] = useState(initialAgentSnapshot.name);
  const [displayAlias, setDisplayAlias] = useState(initialAgentSnapshot.display_alias);
  const [runtime, setRuntime] = useState(initialAgentSnapshot.runtime);
  const [fallbackRuntime, setFallbackRuntime] = useState(initialAgentSnapshot.fallback_runtime);
  const [model, setModel] = useState(initialAgentSnapshot.model);
  const [reasoningEffort, setReasoningEffort] = useState(initialAgentSnapshot.reasoning_effort);
  const [prompt, setPrompt] = useState(initialAgentSnapshot.system_prompt);
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
  const [gender, setGender] = useState<'male' | 'female' | 'neutral'>(initialAgentSnapshot.gender);
  const initialSnapshotRef = useRef<EditableAgentSnapshot>(initialAgentSnapshot);
  const avatarFileRef = useRef<HTMLInputElement>(null);
  const avatarImg2ImgRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.agents.get(agent.id).then(d => {
      initialSnapshotRef.current = snapshotFromAgent(d);
      setRuntime((d as any).runtime || '');
      setName(d.name);
      setDisplayAlias(d.display_alias || '');
      setFallbackRuntime((d as any).fallback_runtime || '');
      setModel(d.model || '');
      setReasoningEffort((d as any).reasoning_effort || '');
      setPrompt((d as any).system_prompt || '');
      setCapabilities((d as any).capabilities || []);
      setAvatarUrl((d as any).avatar_url);
      setGender((d as any).gender || 'neutral');
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
        if (!avatarFile) { setError(t('agent.edit.choosePhotoForImg2Img', 'Choose a photo for img2img')); return; }
        const res = await api.agents.generateAvatarImg2Img(agent.id, avatarFile, avatarPrompt || `Portrait avatar in ${avatarStyle} style`);
        setAvatarUrl(res.avatar_url);
      }
    } catch (e: any) {
      setError(`${t('agent.settings.avatar', 'Avatar')}: ${e.message}`);
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
      setError(`${t('agent.settings.avatar', 'Avatar')}: ${e.message}`);
    } finally {
      setGeneratingAvatar(false);
      if (avatarFileRef.current) avatarFileRef.current.value = '';
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      const patch = buildAgentUpdatePatch(initialSnapshotRef.current, {
        name,
        display_alias: displayAlias,
        runtime,
        fallback_runtime: fallbackRuntime,
        model,
        system_prompt: prompt,
        reasoning_effort: reasoningEffort,
        capabilities,
        gender,
      });
      if (Object.keys(patch).length > 0) {
        await api.agents.update(agent.id, patch);
      }
      onSaved(); onClose();
    } catch (err: any) { setError(err.message); setSubmitting(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 620, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ marginBottom: 12 }}>{t('agent.edit.title', 'Edit agent')} - {agent.id}</h2>
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #e2e8f0', paddingBottom: 8 }}>
          {(['settings', 'memory'] as const).map(tabId => (
            <button key={tabId} onClick={() => setTab(tabId)} style={{
              padding: '5px 14px', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: tab === tabId ? '#6366f1' : '#f1f5f9', color: tab === tabId ? 'white' : '#475569',
            }}>
              {tabId === 'settings' ? t('agent.edit.tabSettings', 'Settings') : t('agent.edit.tabMemory', 'Memory')}
            </button>
          ))}
        </div>

        {tab === 'settings' && (
          <AgentSettingsTab
            agentId={agent.id} name={name} setName={setName}
            displayAlias={displayAlias} setDisplayAlias={setDisplayAlias}
            runtime={runtime} setRuntime={setRuntime}
            fallbackRuntime={fallbackRuntime} setFallbackRuntime={setFallbackRuntime}
            model={model} setModel={setModel}
            reasoningEffort={reasoningEffort} setReasoningEffort={setReasoningEffort}
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
