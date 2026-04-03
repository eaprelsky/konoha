import { useState } from 'react';
import type React from 'react';

// Credentials are validated client-side; nginx handles API auth independently.
const VALID_USER = 'eaprelsky';
const VALID_PASS = 'Ufkbvfnm9';

const styles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #f8fafc;
    font-family: system-ui, -apple-system, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: white;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 40px 36px;
    width: 100%;
    max-width: 360px;
    box-shadow: 0 4px 16px rgba(0,0,0,.08);
  }
  .logo {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-bottom: 32px;
  }
  .logo-icon {
    width: 44px; height: 44px;
    background: #0f172a;
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
  }
  .logo-text { font-size: 20px; font-weight: 700; color: #0f172a; letter-spacing: -0.3px; }
  .logo-sub { font-size: 12px; color: #64748b; margin-top: 2px; }
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: .5px;
    margin-bottom: 6px;
  }
  input {
    width: 100%;
    padding: 10px 14px;
    background: white;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    color: #1e293b;
    font-size: 14px;
    margin-bottom: 16px;
    transition: border-color .15s, box-shadow .15s;
  }
  input:focus {
    outline: none;
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99,102,241,.12);
  }
  input::placeholder { color: #cbd5e1; }
  button[type="submit"] {
    width: 100%;
    padding: 11px;
    background: #6366f1;
    border: none;
    border-radius: 6px;
    color: white;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background .15s;
    margin-top: 4px;
  }
  button[type="submit"]:hover { background: #4f46e5; }
  button[type="submit"]:active { background: #4338ca; }
  button[type="submit"]:disabled { opacity: .5; cursor: not-allowed; }
  .err {
    color: #dc2626;
    font-size: 13px;
    text-align: center;
    margin-top: 14px;
    padding: 8px 12px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 6px;
  }
  .divider { border: none; border-top: 1px solid #f1f5f9; margin: 24px 0 16px; }
  .footer { font-size: 11px; color: #94a3b8; text-align: center; }
`;

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    setTimeout(() => {
      if (username === VALID_USER && password === VALID_PASS) {
        localStorage.setItem('konoha_dash_auth', '1');
        localStorage.setItem('konoha_dash_user', username);
        window.location.replace('/ui/index.html');
      } else {
        setError('Invalid username or password');
        setLoading(false);
      }
    }, 300);
  }

  return (
    <>
      <style>{styles}</style>
      <div className="card">
        <div className="logo">
          <div className="logo-icon">🍃</div>
          <div>
            <div className="logo-text">Konoha</div>
            <div className="logo-sub">Workflow Engine</div>
          </div>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="u">Username</label>
          <input
            id="u"
            type="text"
            autoComplete="username"
            autoFocus
            required
            placeholder="username"
            value={username}
            onChange={e => setUsername(e.target.value)}
          />
          <label htmlFor="p">Password</label>
          <input
            id="p"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          {error && <div className="err">{error}</div>}
        </form>
        <hr className="divider" />
        <div className="footer">Konoha Multi-Agent Platform</div>
      </div>
    </>
  );
}
