export type NavGroup = 'operator' | 'builder' | 'admin';

export type NavItem = {
  keyRu: string;
  keyEn: string;
  to: string;
};

export type NavGroupDef = {
  id: NavGroup;
  keyRu: string;
  keyEn: string;
  pages: string[];
};

export const NAV_GROUPS: NavGroupDef[] = [
  {
    id: 'operator',
    keyRu: 'Оператор',
    keyEn: 'Operator',
    pages: ['/my-tasks', '/monitor', '/cases', '/people', '/roles', '/documents'],
  },
  {
    id: 'builder',
    keyRu: 'Конструктор',
    keyEn: 'Builder',
    pages: ['/editor', '/workitems', '/calendar', '/my-calendar', '/reminders', '/kb'],
  },
  {
    id: 'admin',
    keyRu: 'Администрирование',
    keyEn: 'Admin',
    pages: ['/health', '/connectors', '/agents', '/messages', '/eventlog', '/event-monitor', '/workspace', '/whitelist', '/settings', '/skills'],
  },
];

export const NAV_ITEMS: Record<string, NavItem> = {
  '/my-tasks':      { keyRu: 'Мои задачи',     keyEn: 'My Tasks',   to: '/my-tasks' },
  '/monitor':       { keyRu: 'Витрина',        keyEn: 'Overview',   to: '/monitor' },
  '/cases':         { keyRu: 'Прогоны',        keyEn: 'Cases',      to: '/cases' },
  '/people':        { keyRu: 'Люди',           keyEn: 'People',     to: '/people' },
  '/roles':         { keyRu: 'Роли',           keyEn: 'Roles',      to: '/roles' },
  '/documents':     { keyRu: 'Документы',      keyEn: 'Documents',  to: '/documents' },
  '/editor':        { keyRu: 'Редактор',       keyEn: 'Editor',     to: '/editor' },
  '/workitems':     { keyRu: 'Все задачи',     keyEn: 'Work Items', to: '/workitems' },
  '/calendar':      { keyRu: 'Календарь',      keyEn: 'Calendar',   to: '/calendar' },
  '/my-calendar':   { keyRu: 'Мой календарь',  keyEn: 'My Calendar', to: '/my-calendar' },
  '/reminders':     { keyRu: 'Напоминания',    keyEn: 'Reminders',  to: '/reminders' },
  '/kb':            { keyRu: 'База знаний',    keyEn: 'KB',         to: '/kb' },
  '/health':        { keyRu: 'Состояние',      keyEn: 'Health',     to: '/health' },
  '/connectors':    { keyRu: 'ИС',             keyEn: 'IS',         to: '/connectors' },
  '/agents':        { keyRu: 'Агенты',         keyEn: 'Agents',     to: '/agents' },
  '/messages':      { keyRu: 'Сообщения',      keyEn: 'Messages',   to: '/messages' },
  '/eventlog':      { keyRu: 'Лог событий',    keyEn: 'Event Log',  to: '/eventlog' },
  '/event-monitor': { keyRu: 'Мониторинг',     keyEn: 'Monitor',    to: '/event-monitor' },
  '/workspace':     { keyRu: 'Workspace',      keyEn: 'Workspace',  to: '/workspace' },
  '/whitelist':     { keyRu: 'Доступ',         keyEn: 'Access',     to: '/whitelist' },
  '/settings':      { keyRu: 'Параметры',      keyEn: 'Parameters', to: '/settings' },
  '/skills':        { keyRu: 'Навыки',         keyEn: 'Skills',     to: '/skills' },
};

export function detectGroup(pathname: string): NavGroup {
  for (const group of NAV_GROUPS) {
    if (group.pages.some(page => pathname === page || pathname.startsWith(page + '/'))) {
      return group.id;
    }
  }
  return 'operator';
}

