import { type ReactNode, useEffect, useState, useRef } from 'react';
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

// CSS matching vanilla HTML for e2e test compatibility
const styles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; }
  header { background: #0f172a; color: #f8fafc; padding: 14px 28px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 18px; font-weight: 600; }
  header span { font-size: 12px; color: #64748b; }
  header .spacer { flex: 1; }
  .lang-switch { display: flex; gap: 4px; }
  .lang-btn { padding: 3px 8px; border-radius: 4px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; }
  .lang-btn.active { background: #334155; color: #f8fafc; }
  .lang-btn:hover { background: #1e293b; color: #f8fafc; }
  .logout-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; margin-left: 8px; }
  .logout-btn:hover { background: #7f1d1d; color: #fca5a5; border-color: #7f1d1d; }
  nav { display: flex; gap: 4px; padding: 12px 24px; background: #fff; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
  nav a { padding: 7px 16px; border-radius: 6px; text-decoration: none; color: #475569; font-size: 14px; }
  nav a:hover, nav a.active { background: #f1f5f9; color: #0f172a; font-weight: 500; }
  .sys-menu-wrap { position: relative; }
  .sys-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .sys-btn:hover, .sys-btn.open { background: #1e293b; color: #f8fafc; }
  .sys-dropdown { position: absolute; top: calc(100% + 6px); right: 0; background: #1e293b; border: 1px solid #334155; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.4); z-index: 9999; min-width: 160px; padding: 4px 0; }
  .sys-dropdown a { display: block; padding: 8px 16px; color: #cbd5e1; font-size: 13px; text-decoration: none; white-space: nowrap; }
  .sys-dropdown a:hover, .sys-dropdown a.active { background: #334155; color: #f8fafc; }
`;

const MAIN_NAV = [
  { href: '/ui/index.html',      key: 'nav.dashboard',  fallback: 'Dashboard' },
  { href: '/ui/processes.html',  key: 'nav.processes',  fallback: 'Processes' },
  { href: '/ui/workitems.html',  key: 'nav.workitems',  fallback: 'Work Items' },
  { href: '/ui/reminders.html',  key: 'nav.reminders',  fallback: 'Reminders' },
  { href: '/ui/cases.html',      key: 'nav.cases',      fallback: 'Cases' },
  { href: '/ui/roles.html',      key: 'nav.roles',      fallback: 'Roles' },
  { href: '/ui/documents.html',  key: 'nav.documents',  fallback: 'Documents' },
  { href: '/ui/connectors.html', key: 'nav.connectors', fallback: 'Connectors' },
  { href: '/ui/people.html',     key: 'nav.people',     fallback: 'People' },
];

const SYS_NAV = [
  { href: '/ui/agents.html',     key: 'nav.agents',     fallback: 'Agents' },
  { href: '/ui/messages.html',   key: 'nav.messages',   fallback: 'Messages' },
  { href: '/ui/eventlog.html',   key: 'nav.eventlog',   fallback: 'Event Log' },
  { href: '/ui/kb.html',         key: 'nav.kb',         fallback: 'KB' },
  { href: '/ui/editor.html',     key: 'nav.editor',     fallback: 'Editor' },
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
  const [sysOpen, setSysOpen] = useState(false);
  const sysRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sysRef.current && !sysRef.current.contains(e.target as Node)) setSysOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const sysActive = SYS_NAV.some(({ href }) => href.endsWith(activePage));

  return (
    <>
      <style>{styles}</style>
      <header>
        <h1>Konoha Workflow Engine</h1>
        {subtitle && <span>{subtitle}</span>}
        <div className="spacer" />
        <div className="lang-switch">
          <button className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')}>EN</button>
          <button className={`lang-btn${lang === 'ru' ? ' active' : ''}`} onClick={() => setLang('ru')}>RU</button>
        </div>
        <div className="sys-menu-wrap" ref={sysRef}>
          <button
            className={`sys-btn${sysOpen || sysActive ? ' open' : ''}`}
            onClick={() => setSysOpen(v => !v)}
          >
            ⚙ {t('nav.system', 'System')}
          </button>
          {sysOpen && (
            <div className="sys-dropdown">
              {SYS_NAV.map(({ href, key, fallback }) => (
                <a
                  key={href}
                  href={href}
                  className={href.endsWith(activePage) ? 'active' : undefined}
                  onClick={() => setSysOpen(false)}
                >
                  {t(key, fallback)}
                </a>
              ))}
            </div>
          )}
        </div>
        <button className="logout-btn" onClick={() => { localStorage.removeItem('konoha_dash_auth'); window.location.replace('/ui/login.html'); }}>
          Logout
        </button>
      </header>
      <nav>
        {MAIN_NAV.map(({ href, key, fallback }) => (
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
