import { useState } from 'react';
import { Link, useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useI18n } from '../context/I18nContext';
import { useSubtitle } from '../context/SubtitleContext';
import { ProfileModal } from './ProfileModal';

export function isLoggedIn(): boolean {
  return localStorage.getItem('konoha_dash_auth') === '1';
}

// ── Group-based navigation (3-layer redesign, closes #295) ───────────────────

type NavGroup = 'processes' | 'team' | 'settings';

const NAV_GROUPS: { id: NavGroup; keyRu: string; keyEn: string; pages: string[] }[] = [
  {
    id: 'processes',
    keyRu: 'Процессы',
    keyEn: 'Processes',
    pages: ['/processes', '/editor', '/monitor', '/documents', '/cases', '/workitems', '/my-tasks', '/my-calendar', '/calendar', '/reminders'],
  },
  {
    id: 'team',
    keyRu: 'Команда',
    keyEn: 'Team',
    pages: ['/roles', '/agents', '/people', '/skills'],
  },
  {
    id: 'settings',
    keyRu: 'Настройки',
    keyEn: 'Settings',
    pages: ['/settings', '/health', '/connectors', '/messages', '/eventlog', '/kb', '/workspace', '/whitelist', '/admin', '/event-monitor'],
  },
];

const NAV_ITEMS: Record<string, { keyRu: string; keyEn: string; to: string }> = {
  '/processes':    { keyRu: 'Каталог',        keyEn: 'Catalog',    to: '/processes' },
  '/editor':       { keyRu: 'Редактор',       keyEn: 'Editor',     to: '/editor' },
  '/monitor':      { keyRu: 'Монитор',        keyEn: 'Monitor',    to: '/monitor' },
  '/documents':    { keyRu: 'Документы',      keyEn: 'Documents',  to: '/documents' },
  '/cases':        { keyRu: 'Прогоны',        keyEn: 'Cases',      to: '/cases' },
  '/workitems':    { keyRu: 'Задачи',         keyEn: 'Work Items', to: '/workitems' },
  '/my-tasks':     { keyRu: 'Мои задачи',     keyEn: 'My Tasks',   to: '/my-tasks' },
  '/my-calendar':  { keyRu: 'Мой календарь',  keyEn: 'My Cal',     to: '/my-calendar' },
  '/calendar':     { keyRu: 'Календарь',      keyEn: 'Calendar',   to: '/calendar' },
  '/reminders':    { keyRu: 'Напоминания',    keyEn: 'Reminders',  to: '/reminders' },
  '/roles':        { keyRu: 'Роли',           keyEn: 'Roles',      to: '/roles' },
  '/agents':       { keyRu: 'Агенты',         keyEn: 'Agents',     to: '/agents' },
  '/people':       { keyRu: 'Люди',           keyEn: 'People',     to: '/people' },
  '/skills':       { keyRu: 'Навыки',         keyEn: 'Skills',     to: '/skills' },
  '/settings':     { keyRu: 'Параметры',      keyEn: 'Parameters', to: '/settings' },
  '/health':       { keyRu: 'Состояние',      keyEn: 'Health',     to: '/health' },
  '/connectors':   { keyRu: 'ИС',             keyEn: 'IS',         to: '/connectors' },
  '/messages':     { keyRu: 'Сообщения',      keyEn: 'Messages',   to: '/messages' },
  '/eventlog':     { keyRu: 'Лог событий',    keyEn: 'Event Log',  to: '/eventlog' },
  '/event-monitor':{ keyRu: 'Мониторинг',     keyEn: 'Monitor',    to: '/event-monitor' },
  '/kb':           { keyRu: 'База знаний',    keyEn: 'KB',         to: '/kb' },
  '/workspace':    { keyRu: 'Workspace',      keyEn: 'Workspace',  to: '/workspace' },
  '/whitelist':    { keyRu: 'Доступ',         keyEn: 'Access',     to: '/whitelist' },
  '/admin':        { keyRu: 'Агенты (adm)',   keyEn: 'Agents (adm)', to: '/admin' },
};

function detectGroup(pathname: string): NavGroup {
  for (const g of NAV_GROUPS) {
    if (g.pages.includes(pathname)) return g.id;
  }
  return 'settings';
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
  children?: React.ReactNode;
  activePage?: string;   // kept for backward compat, unused
  subtitle?: string;     // kept for backward compat, unused (use SubtitleContext instead)
}

export function Layout({ children }: LayoutProps) {
  const { lang, setLang } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const subtitle = useSubtitle();
  const [showProfile, setShowProfile] = useState(false);
  const [activeGroup, setActiveGroup] = useState<NavGroup>(() => detectGroup(location.pathname));

  // Keep activeGroup in sync with navigation
  const currentGroup = detectGroup(location.pathname);
  const activeGroupResolved = currentGroup !== 'settings' || NAV_GROUPS.find(g => g.id === activeGroup) ? currentGroup : activeGroup;

  function label(item: { keyRu: string; keyEn: string }) {
    return lang === 'ru' ? item.keyRu : item.keyEn;
  }

  const group = NAV_GROUPS.find(g => g.id === activeGroupResolved)!;
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
              className={`kw-group-btn${activeGroupResolved === g.id ? ' active' : ''}`}
              onClick={() => {
                const firstPage = g.pages[0];
                const firstItem = NAV_ITEMS[firstPage];
                if (firstItem) {
                  navigate(firstItem.to);
                } else {
                  setActiveGroup(g.id);
                }
              }}
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
          <button className="logout-btn" onClick={() => { localStorage.removeItem('konoha_dash_auth'); navigate('/login'); }}>
            {lang === 'ru' ? 'Выйти' : 'Logout'}
          </button>
        </div>
      </header>
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      <nav>
        {subItems.map(item => (
          <Link
            key={item.to}
            to={item.to}
            className={location.pathname === item.to ? 'active' : undefined}
          >
            {label(item)}
          </Link>
        ))}
      </nav>
      {children ?? <Outlet />}
    </>
  );
}
