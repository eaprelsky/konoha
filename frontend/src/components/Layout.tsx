import { type ReactNode, useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { ProfileModal } from './ProfileModal';

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

// ── Group-based navigation ────────────────────────────────────────────────────

type NavGroup = 'user' | 'executors' | 'processes' | 'system';

const NAV_GROUPS: { id: NavGroup; keyRu: string; keyEn: string; pages: string[] }[] = [
  {
    id: 'user',
    keyRu: 'Пользователь',
    keyEn: 'User',
    pages: ['my-tasks.html', 'calendar.html'],
  },
  {
    id: 'executors',
    keyRu: 'Исполнители',
    keyEn: 'Executors',
    pages: ['roles.html', 'agents.html', 'people.html', 'skills.html'],
  },
  {
    id: 'processes',
    keyRu: 'Процессы',
    keyEn: 'Processes',
    pages: ['editor.html', 'monitor.html', 'calendar.html', 'documents.html'],
  },
  {
    id: 'system',
    keyRu: 'Система',
    keyEn: 'System',
    pages: ['connectors.html', 'messages.html', 'eventlog.html', 'kb.html', 'workspace.html', 'admin.html', 'health.html'],
  },
];

const NAV_ITEMS: Record<string, { keyRu: string; keyEn: string; href: string }> = {
  'my-tasks.html':     { keyRu: 'Мои задачи',    keyEn: 'My Tasks',   href: '/ui/my-tasks.html' },
  'calendar.html':     { keyRu: 'Календарь',      keyEn: 'Calendar',   href: '/ui/calendar.html' },
  'roles.html':        { keyRu: 'Роли',            keyEn: 'Roles',      href: '/ui/roles.html' },
  'agents.html':       { keyRu: 'Агенты',          keyEn: 'Agents',     href: '/ui/agents.html' },
  'people.html':       { keyRu: 'Люди',            keyEn: 'People',     href: '/ui/people.html' },
  'skills.html':       { keyRu: 'Навыки',          keyEn: 'Skills',     href: '/ui/skills.html' },
  'editor.html':       { keyRu: 'Редактор',        keyEn: 'Editor',     href: '/ui/editor.html' },
  'monitor.html':      { keyRu: 'Монитор',         keyEn: 'Monitor',    href: '/ui/monitor.html' },
  'documents.html':    { keyRu: 'Документы',       keyEn: 'Documents',  href: '/ui/documents.html' },
  'connectors.html':   { keyRu: 'ИС',              keyEn: 'IS',         href: '/ui/connectors.html' },
  'messages.html':     { keyRu: 'Сообщения',       keyEn: 'Messages',   href: '/ui/messages.html' },
  'eventlog.html':     { keyRu: 'Лог событий',     keyEn: 'Event Log',  href: '/ui/eventlog.html' },
  'kb.html':           { keyRu: 'База знаний',      keyEn: 'KB',         href: '/ui/kb.html' },
  'workspace.html':    { keyRu: 'Workspace',        keyEn: 'Workspace',  href: '/ui/workspace.html' },
  'admin.html':        { keyRu: 'Админ',            keyEn: 'Admin',      href: '/ui/admin.html' },
  'health.html':       { keyRu: 'Состояние',        keyEn: 'Health',     href: '/ui/health.html' },
};

function detectGroup(page: string): NavGroup {
  for (const g of NAV_GROUPS) {
    if (g.pages.includes(page)) return g.id;
  }
  return 'system';
}

const styles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; }

  /* Header */
  .kw-header { background: #0f172a; color: #f8fafc; padding: 0 28px; display: flex; align-items: center; gap: 16px; height: 52px; }
  .kw-header h1 { font-size: 17px; font-weight: 700; color: #fff; white-space: nowrap; }
  .kw-header .spacer { flex: 1; }
  .kw-header-right { display: flex; align-items: center; gap: 8px; }

  /* Group tabs (top-level nav) */
  .kw-groups { display: flex; gap: 2px; background: #1e293b; border-radius: 6px; padding: 2px; }
  .kw-group-btn { padding: 5px 14px; border-radius: 5px; border: none; background: transparent; color: #94a3b8; font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: background .15s; }
  .kw-group-btn.active { background: #334155; color: #f8fafc; font-weight: 600; }
  .kw-group-btn:hover:not(.active) { background: #263347; color: #cbd5e1; }

  /* Lang switch */
  .lang-switch { display: flex; gap: 3px; }
  .lang-btn { padding: 3px 8px; border-radius: 4px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; }
  .lang-btn.active { background: #334155; color: #f8fafc; }
  .lang-btn:hover { background: #1e293b; color: #f8fafc; }

  /* Profile / logout */
  .logout-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; }
  .logout-btn:hover { background: #7f1d1d; color: #fca5a5; border-color: #7f1d1d; }
  .profile-btn { padding: 3px 10px; border-radius: 4px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; }
  .profile-btn:hover { background: #1e293b; color: #f8fafc; }

  /* Sub-nav */
  nav { display: flex; gap: 2px; padding: 8px 24px; background: #fff; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
  nav a { padding: 6px 14px; border-radius: 6px; text-decoration: none; color: #475569; font-size: 14px; font-weight: 500; white-space: nowrap; }
  nav a:hover { background: #f1f5f9; color: #0f172a; }
  nav a.active { background: #eff6ff; color: #1d4ed8; }
`;

interface LayoutProps {
  children: ReactNode;
  activePage: string;
  subtitle?: string;
}

export function Layout({ children, activePage, subtitle }: LayoutProps) {
  useAuthGuard();
  const { lang, setLang } = useI18n();
  const [showProfile, setShowProfile] = useState(false);
  const [activeGroup, setActiveGroup] = useState<NavGroup>(() => detectGroup(activePage));

  function label(item: { keyRu: string; keyEn: string }) {
    return lang === 'ru' ? item.keyRu : item.keyEn;
  }

  const group = NAV_GROUPS.find(g => g.id === activeGroup)!;
  const subItems = group.pages.map(p => NAV_ITEMS[p]).filter(Boolean);

  return (
    <>
      <style>{styles}</style>
      <header className="kw-header">
        <h1>Konoha WE</h1>
        {subtitle && <span style={{ fontSize: 12, color: '#64748b' }}>{subtitle}</span>}
        <div className="spacer" />
        <div className="kw-groups">
          {NAV_GROUPS.map(g => (
            <button
              key={g.id}
              className={`kw-group-btn${activeGroup === g.id ? ' active' : ''}`}
              onClick={() => setActiveGroup(g.id)}
            >
              {lang === 'ru' ? g.keyRu : g.keyEn}
            </button>
          ))}
        </div>
        <div className="kw-header-right">
          <div className="lang-switch">
            <button className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')}>EN</button>
            <button className={`lang-btn${lang === 'ru' ? ' active' : ''}`} onClick={() => setLang('ru')}>RU</button>
          </div>
          <button className="profile-btn" onClick={() => setShowProfile(true)}>👤</button>
          <button className="logout-btn" onClick={() => { localStorage.removeItem('konoha_dash_auth'); window.location.replace('/ui/login.html'); }}>
            {lang === 'ru' ? 'Выйти' : 'Logout'}
          </button>
        </div>
      </header>
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      <nav>
        {subItems.map(item => (
          <a
            key={item.href}
            href={item.href}
            className={item.href.endsWith(activePage) ? 'active' : undefined}
          >
            {label(item)}
          </a>
        ))}
      </nav>
      {children}
    </>
  );
}
