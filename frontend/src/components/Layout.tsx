import { type ReactNode } from 'react';
import { useI18n } from '../context/I18nContext';

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
  nav { display: flex; gap: 4px; padding: 12px 24px; background: #fff; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
  nav a { padding: 7px 16px; border-radius: 6px; text-decoration: none; color: #475569; font-size: 14px; }
  nav a:hover, nav a.active { background: #f1f5f9; color: #0f172a; font-weight: 500; }
`;

const NAV_LINKS = [
  { href: '/ui/index.html',      key: 'nav.dashboard',  fallback: 'Dashboard' },
  { href: '/ui/processes.html',  key: 'nav.processes',  fallback: 'Processes' },
  { href: '/ui/workitems.html',  key: 'nav.workitems',  fallback: 'Work Items' },
  { href: '/ui/reminders.html',  key: 'nav.reminders',  fallback: 'Reminders' },
  { href: '/ui/cases.html',      key: 'nav.cases',      fallback: 'Cases' },
  { href: '/ui/roles.html',      key: 'nav.roles',      fallback: 'Roles' },
  { href: '/ui/documents.html',  key: 'nav.documents',  fallback: 'Documents' },
  { href: '/ui/connectors.html', key: 'nav.connectors', fallback: 'Connectors' },
  { href: '/ui/eventlog.html',   key: 'nav.eventlog',   fallback: 'Event Log' },
  { href: '/ui/agents.html',     key: 'nav.agents',     fallback: 'Agents' },
  { href: '/ui/messages.html',   key: 'nav.messages',   fallback: 'Messages' },
  { href: '/ui/health.html',     key: 'nav.health',     fallback: 'Health' },
  { href: '/ui/kb.html',         key: 'nav.kb',         fallback: 'KB' },
  { href: '/ui/admin.html',      key: 'nav.admin',      fallback: 'Admin' },
  { href: '/ui/editor.html',     key: 'nav.editor',     fallback: 'Editor' },
];

interface LayoutProps {
  children: ReactNode;
  activePage: string; // e.g. 'index.html'
  subtitle?: string;
}

export function Layout({ children, activePage, subtitle }: LayoutProps) {
  const { lang, setLang, t } = useI18n();

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
      </header>
      <nav>
        {NAV_LINKS.map(({ href, key, fallback }) => (
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
