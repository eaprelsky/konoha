import { type ReactNode, useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';

export function isLoggedIn(): boolean {
  return localStorage.getItem('konoha_dash_auth') === '1';
}

function useAuthGuard() {
  useEffect(() => {
    if (!isLoggedIn()) {
      window.location.replace('/ui/login.html');
    }
  }, []);
}

type Role = 'architect' | 'admin';
const ROLE_KEY = 'konoha_role';

function getRole(): Role {
  return (localStorage.getItem(ROLE_KEY) as Role) || 'architect';
}

// CSS matching vanilla HTML for e2e test compatibility
const styles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; }
  header { background: #0f172a; color: #f8fafc; padding: 14px 28px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 18px; font-weight: 600; color: #ffffff; }
  header span { font-size: 12px; color: #64748b; }
  header .spacer { flex: 1; }
  .lang-switch { display: flex; gap: 4px; }
  .lang-btn { padding: 3px 8px; border-radius: 4px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; }
  .lang-btn.active { background: #334155; color: #f8fafc; }
  .lang-btn:hover { background: #1e293b; color: #f8fafc; }
  .logout-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; margin-left: 4px; }
  .logout-btn:hover { background: #7f1d1d; color: #fca5a5; border-color: #7f1d1d; }
  .role-switch { display: flex; gap: 2px; background: #1e293b; border-radius: 6px; padding: 2px; }
  .role-btn { padding: 4px 10px; border-radius: 4px; border: none; background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; white-space: nowrap; transition: background 0.15s; }
  .role-btn.active { background: #334155; color: #f8fafc; font-weight: 600; }
  .role-btn:hover:not(.active) { background: #263347; color: #cbd5e1; }
  nav { display: flex; gap: 4px; padding: 12px 24px; background: #fff; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
  nav a { padding: 7px 16px; border-radius: 6px; text-decoration: none; color: #475569; font-size: 14px; }
  nav a:hover, nav a.active { background: #f1f5f9; color: #0f172a; font-weight: 500; }
`;

const MAIN_NAV = [
  { href: '/ui/index.html',      key: 'nav.dashboard',  fallback: 'Dashboard' },
  { href: '/ui/processes.html',  key: 'nav.processes',  fallback: 'Processes' },
  { href: '/ui/cases.html',      key: 'nav.cases',      fallback: 'Cases' },
  { href: '/ui/workitems.html',  key: 'nav.workitems',  fallback: 'Work Items' },
  { href: '/ui/reminders.html',  key: 'nav.reminders',  fallback: 'Reminders' },
  { href: '/ui/roles.html',      key: 'nav.roles',      fallback: 'Roles' },
  { href: '/ui/documents.html',  key: 'nav.documents',  fallback: 'Documents' },
  { href: '/ui/connectors.html', key: 'nav.connectors', fallback: 'IS' },
  { href: '/ui/people.html',     key: 'nav.people',     fallback: 'People' },
  { href: '/ui/agents.html',     key: 'nav.agents',     fallback: 'Agents' },
  { href: '/ui/editor.html',     key: 'nav.editor',     fallback: 'Editor' },
];

const SYS_NAV = [
  { href: '/ui/messages.html',   key: 'nav.messages',   fallback: 'Messages' },
  { href: '/ui/eventlog.html',   key: 'nav.eventlog',   fallback: 'Event Log' },
  { href: '/ui/kb.html',         key: 'nav.kb',         fallback: 'KB' },
  { href: '/ui/admin.html',      key: 'nav.admin',      fallback: 'Admin' },
];

interface LayoutProps {
  children: ReactNode;
  activePage: string; // e.g. 'index.html'
  subtitle?: string;
}

export function Layout({ children, activePage, subtitle }: LayoutProps) {
  useAuthGuard();
  const { lang, setLang, t } = useI18n();

  // Determine initial role: if current page belongs to SYS_NAV, force admin view
  const pageInSys = SYS_NAV.some(({ href }) => href.endsWith(activePage));
  const [role, setRole] = useState<Role>(() => pageInSys ? 'admin' : getRole());

  function switchRole(r: Role) {
    localStorage.setItem(ROLE_KEY, r);
    setRole(r);
  }

  const navLinks = role === 'admin' ? SYS_NAV : MAIN_NAV;

  return (
    <>
      <style>{styles}</style>
      <header>
        <h1>Konoha Workflow Engine</h1>
        {subtitle && <span>{subtitle}</span>}
        <div className="spacer" />
        <div className="role-switch">
          <button
            className={`role-btn${role === 'architect' ? ' active' : ''}`}
            onClick={() => switchRole('architect')}
          >
            {t('role.architect', 'Процессы')}
          </button>
          <button
            className={`role-btn${role === 'admin' ? ' active' : ''}`}
            onClick={() => switchRole('admin')}
          >
            {t('role.admin', 'Система')}
          </button>
        </div>
        <div className="lang-switch">
          <button className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')}>EN</button>
          <button className={`lang-btn${lang === 'ru' ? ' active' : ''}`} onClick={() => setLang('ru')}>RU</button>
        </div>
        <button className="logout-btn" onClick={() => { localStorage.removeItem('konoha_dash_auth'); window.location.replace('/ui/login.html'); }}>
          Logout
        </button>
      </header>
      <nav>
        {navLinks.map(({ href, key, fallback }) => (
          <a
            key={href}
            href={href}
            className={href.endsWith(activePage) ? 'active' : undefined}
          >
            {t(key, fallback)}
          </a>
        ))}
      </nav>
      {children}
    </>
  );
}
