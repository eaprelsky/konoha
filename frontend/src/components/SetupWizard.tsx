/**
 * SetupWizard — first-run onboarding (closes #295)
 * Shown instead of Layout when GET /api/setup/status → { complete: false }
 *
 * Steps:
 *   1. Владелец (Telegram ID)
 *   2. LLM-провайдер (API key)
 *   3. GitHub (PAT + repo)
 *   4. Безопасность (admin token)
 */

import { useState } from 'react';

interface SetupData {
  owner_tg_id: string;
  llm_api_key: string;
  llm_provider: string;
  github_pat: string;
  github_repo: string;
  admin_token: string;
}

const CSS = `
  .sw-overlay {
    position: fixed; inset: 0; background: #0f172a;
    display: flex; align-items: center; justify-content: center;
    z-index: 99999; font-family: system-ui, -apple-system, sans-serif;
  }
  .sw-card {
    background: #fff; border-radius: 16px; padding: 40px 48px;
    width: 480px; max-width: 95vw; box-shadow: 0 24px 64px rgba(0,0,0,.4);
  }
  .sw-logo { font-size: 28px; font-weight: 800; color: #0f172a; margin-bottom: 6px; }
  .sw-tagline { font-size: 13px; color: #64748b; margin-bottom: 32px; }
  .sw-steps { display: flex; gap: 6px; margin-bottom: 32px; }
  .sw-step-dot {
    flex: 1; height: 4px; border-radius: 2px; background: #e2e8f0;
    transition: background .2s;
  }
  .sw-step-dot.done { background: #6366f1; }
  .sw-step-dot.active { background: #818cf8; }
  .sw-step-title { font-size: 18px; font-weight: 700; color: #0f172a; margin-bottom: 6px; }
  .sw-step-desc { font-size: 13px; color: #64748b; margin-bottom: 24px; line-height: 1.6; }
  .sw-field { margin-bottom: 18px; }
  .sw-label { display: block; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 6px; }
  .sw-input {
    width: 100%; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;
    color: #1e293b; font-size: 14px; padding: 10px 14px; outline: none;
    box-sizing: border-box; transition: border-color .15s;
  }
  .sw-input:focus { border-color: #6366f1; }
  .sw-input::placeholder { color: #94a3b8; }
  .sw-hint { font-size: 11px; color: #94a3b8; margin-top: 4px; }
  .sw-actions { display: flex; gap: 10px; justify-content: space-between; margin-top: 28px; align-items: center; }
  .sw-btn-primary {
    background: #6366f1; border: none; color: white; border-radius: 8px;
    padding: 10px 24px; font-size: 14px; font-weight: 600; cursor: pointer;
    transition: background .15s;
  }
  .sw-btn-primary:hover:not(:disabled) { background: #4f46e5; }
  .sw-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
  .sw-btn-secondary {
    background: none; border: 1px solid #e2e8f0; color: #64748b; border-radius: 8px;
    padding: 10px 20px; font-size: 14px; cursor: pointer;
    transition: background .15s;
  }
  .sw-btn-secondary:hover { background: #f8fafc; }
  .sw-skip { font-size: 12px; color: #94a3b8; cursor: pointer; text-decoration: underline; }
  .sw-skip:hover { color: #64748b; }
  .sw-error { color: #dc2626; font-size: 12px; margin-top: 8px; }
  .sw-success { text-align: center; padding: 16px 0; }
  .sw-success-icon { font-size: 48px; margin-bottom: 12px; }
  .sw-success-title { font-size: 20px; font-weight: 700; color: #0f172a; margin-bottom: 8px; }
  .sw-success-desc { font-size: 13px; color: #64748b; }
`;

const STEPS = [
  {
    title: 'Владелец системы',
    desc: 'Укажите Telegram ID владельца. Только этот пользователь сможет выдавать команды системным агентам.',
    fields: [
      { key: 'owner_tg_id', label: 'Telegram ID', placeholder: '93791246', hint: 'Числовой ID, не username. Узнать: @userinfobot' },
    ],
  },
  {
    title: 'LLM-провайдер',
    desc: 'Введите API-ключ языковой модели. Konoha использует Anthropic Claude по умолчанию.',
    fields: [
      { key: 'llm_api_key', label: 'API Key', placeholder: 'sk-ant-api03-...', hint: 'console.anthropic.com → API Keys', secret: true },
      { key: 'llm_provider', label: 'Провайдер', placeholder: 'anthropic', hint: 'Оставьте "anthropic" если используете Claude' },
    ],
  },
  {
    title: 'GitHub',
    desc: 'Personal Access Token нужен для создания issues и работы агентов с репозиторием Konoha.',
    fields: [
      { key: 'github_pat', label: 'Personal Access Token', placeholder: 'ghp_...', hint: 'github.com → Settings → Developer settings → PAT', secret: true },
      { key: 'github_repo', label: 'Репозиторий', placeholder: 'username/konoha', hint: 'Репозиторий для GitHub Issues агентов' },
    ],
  },
  {
    title: 'Безопасность',
    desc: 'Задайте токен администратора для доступа к API. Используется Nginx для авторизации запросов.',
    fields: [
      { key: 'admin_token', label: 'Admin Token', placeholder: 'Придумайте надёжный токен', hint: 'Минимум 16 символов. Сохраните — потом не покажем.', secret: true },
    ],
  },
] as const;

type StepKey = typeof STEPS[number]['fields'][number]['key'];

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<SetupData>({
    owner_tg_id: '', llm_api_key: '', llm_provider: 'anthropic',
    github_pat: '', github_repo: 'eaprelsky/konoha', admin_token: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const currentStep = STEPS[step];

  function update(key: StepKey, value: string) {
    setData(d => ({ ...d, [key]: value }));
    setError('');
  }

  function canProceed() {
    // Optional fields: all steps can be skipped except security (admin_token)
    return true;
  }

  async function finish() {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setDone(true);
      setTimeout(onComplete, 2000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function next() {
    if (step < STEPS.length - 1) setStep(s => s + 1);
    else finish();
  }

  function back() {
    if (step > 0) setStep(s => s - 1);
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="sw-overlay">
        <div className="sw-card">
          <div className="sw-logo">🌿 Konoha WE</div>
          <div className="sw-tagline">Настройка системы — займёт 2 минуты</div>

          {/* Step progress */}
          <div className="sw-steps">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`sw-step-dot${i < step ? ' done' : i === step ? ' active' : ''}`}
              />
            ))}
          </div>

          {done ? (
            <div className="sw-success">
              <div className="sw-success-icon">✅</div>
              <div className="sw-success-title">Готово!</div>
              <div className="sw-success-desc">Konoha настроен. Переходим в систему…</div>
            </div>
          ) : (
            <>
              <div className="sw-step-title">
                Шаг {step + 1} из {STEPS.length}: {currentStep.title}
              </div>
              <div className="sw-step-desc">{currentStep.desc}</div>

              {currentStep.fields.map(field => (
                <div className="sw-field" key={field.key}>
                  <label className="sw-label">{field.label}</label>
                  <input
                    className="sw-input"
                    type={field.secret ? 'password' : 'text'}
                    placeholder={field.placeholder}
                    value={data[field.key]}
                    onChange={e => update(field.key, e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && next()}
                    autoComplete={field.secret ? 'new-password' : 'off'}
                  />
                  <div className="sw-hint">{field.hint}</div>
                </div>
              ))}

              {error && <div className="sw-error">{error}</div>}

              <div className="sw-actions">
                {step > 0 ? (
                  <button className="sw-btn-secondary" onClick={back}>← Назад</button>
                ) : (
                  <span />
                )}
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  {step < STEPS.length - 1 && (
                    <span className="sw-skip" onClick={next}>Пропустить</span>
                  )}
                  <button
                    className="sw-btn-primary"
                    onClick={next}
                    disabled={saving}
                  >
                    {saving ? 'Сохранение…' : step === STEPS.length - 1 ? 'Завершить ✓' : 'Далее →'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
