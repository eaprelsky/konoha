import { useState } from 'react';
import { Link, useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useI18n } from '../context/I18nContext';
import { useSubtitle } from '../context/SubtitleContext';
import { useBranding } from '../context/BrandingContext';
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
    pages: ['/settings', '/health', '/connectors', '/messages', '/eventlog', '/kb', '/workspace', '/whitelist', '/event-monitor'],
  },
];

const NAV_ITEMS: Record<string, { keyRu: string; keyEn: string; to: string }> = {
  '/processes':    { keyRu: 'Каталог',        keyEn: 'Catalog',    to: '/processes' },
  '/editor':       { keyRu: 'Редактор',       keyEn: 'Editor',     to: '/editor' },
  '/cases':        { keyRu: 'Прогоны',        keyEn: 'Cases',      to: '/cases' },
  '/workitems':    { keyRu: 'Задачи',         keyEn: 'Work Items', to: '/workitems' },
  '/calendar':     { keyRu: 'Календарь',      keyEn: 'Calendar',   to: '/calendar' },
  '/documents':    { keyRu: 'Документы',      keyEn: 'Documents',  to: '/documents' },
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
};

function detectGroup(pathname: string): NavGroup {
  for (const g of NAV_GROUPS) {
    if (g.pages.some(p => pathname === p || pathname.startsWith(p + '/'))) return g.id;
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

  /* Hamburger (mobile only) */
  .kw-hamburger { display: none; border: none; background: transparent; color: #94a3b8; font-size: 22px; cursor: pointer; padding: 4px 8px; line-height: 1; }
  .kw-hamburger:hover { color: #f8fafc; }

  /* Mobile drawer overlay */
  .kw-drawer-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 200; }
  .kw-drawer-overlay.open { display: block; }
  .kw-drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 280px; background: #0f172a; z-index: 201; display: flex; flex-direction: column; padding: 16px 0; overflow-y: auto; transform: translateX(-100%); transition: transform .2s; }
  .kw-drawer.open { transform: translateX(0); }
  .kw-drawer-close { align-self: flex-end; margin-right: 16px; margin-bottom: 8px; border: none; background: transparent; color: #94a3b8; font-size: 20px; cursor: pointer; padding: 4px 8px; }
  .kw-drawer-section { padding: 8px 0; border-bottom: 1px solid #1e293b; }
  .kw-drawer-group { padding: 6px 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #475569; }
  .kw-drawer-link { display: block; padding: 10px 28px; color: #94a3b8; text-decoration: none; font-size: 14px; font-weight: 500; }
  .kw-drawer-link:hover, .kw-drawer-link.active { background: #1e293b; color: #f8fafc; }
  .kw-drawer-footer { margin-top: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
  .kw-drawer-lang { display: flex; gap: 6px; }
  .kw-drawer-btn { flex: 1; padding: 8px; border-radius: 6px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 13px; cursor: pointer; }
  .kw-drawer-btn.active { background: #334155; color: #f8fafc; }
  .kw-drawer-action { padding: 8px 12px; border-radius: 6px; border: 1px solid #334155; background: transparent; color: #94a3b8; font-size: 13px; cursor: pointer; text-align: left; }
  .kw-drawer-action:hover { background: #1e293b; color: #f8fafc; }

  /* Mobile breakpoint */
  @media (max-width: 767px) {
    .kw-header { padding: 0 16px; }
    .kw-groups, .kw-header-right { display: none; }
    .kw-hamburger { display: block; }
    nav { padding: 8px 12px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
    nav::-webkit-scrollbar { display: none; }
    /* Touch targets: min 44px for subnav links (#361) */
    nav a { min-height: 44px; display: inline-flex; align-items: center; padding: 0 14px; }
  }
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
  const branding = useBranding();
  const [showProfile, setShowProfile] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
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
        {branding.theme.logo_url
          ? <img src={branding.theme.logo_url} alt={branding.product_name} style={{ height: 28 }} />
          : <h1>{branding.product_name}</h1>}

        {subtitle && <span style={{ fontSize: 12, color: '#64748b' }}>{subtitle}</span>}
        <div className="spacer" />
        <button className="kw-hamburger" onClick={() => setShowDrawer(true)}>☰</button>
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

      {/* Mobile drawer */}
      {showDrawer && (
        <>
          <div className="kw-drawer-overlay open" onClick={() => setShowDrawer(false)} />
          <div className="kw-drawer open">
            <button className="kw-drawer-close" onClick={() => setShowDrawer(false)}>✕</button>
            {NAV_GROUPS.map(g => (
              <div key={g.id} className="kw-drawer-section">
                <div className="kw-drawer-group">{lang === 'ru' ? g.keyRu : g.keyEn}</div>
                {g.pages.map(p => {
                  const item = NAV_ITEMS[p];
                  if (!item) return null;
                  return (
                    <Link
                      key={p}
                      to={item.to}
                      className={`kw-drawer-link${location.pathname === item.to ? ' active' : ''}`}
                      onClick={() => setShowDrawer(false)}
                    >
                      {lang === 'ru' ? item.keyRu : item.keyEn}
                    </Link>
                  );
                })}
              </div>
            ))}
            <div className="kw-drawer-footer">
              <div className="kw-drawer-lang">
                <button className={`kw-drawer-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')}>EN</button>
                <button className={`kw-drawer-btn${lang === 'ru' ? ' active' : ''}`} onClick={() => setLang('ru')}>RU</button>
              </div>
              <button className="kw-drawer-action" onClick={() => { setShowDrawer(false); setShowProfile(true); }}>
                👤 {lang === 'ru' ? 'Профиль' : 'Profile'}
              </button>
              <button className="kw-drawer-action" onClick={() => { localStorage.removeItem('konoha_dash_auth'); navigate('/login'); }}>
                {lang === 'ru' ? 'Выйти' : 'Logout'}
              </button>
            </div>
          </div>
        </>
      )}

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
