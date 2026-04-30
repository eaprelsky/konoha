export type NavGroup = 'operator' | 'builder' | 'admin';

export type NavItem = {
  labelKey: string;
  fallback: string;
  to: string;
};

export type NavGroupDef = {
  id: NavGroup;
  labelKey: string;
  fallback: string;
  pages: string[];
};

export const NAV_GROUPS: NavGroupDef[] = [
  {
    id: 'operator',
    labelKey: 'nav.group.operator',
    fallback: 'Operator',
    pages: ['/my-tasks', '/monitor', '/cases', '/people', '/roles', '/documents'],
  },
  {
    id: 'builder',
    labelKey: 'nav.group.builder',
    fallback: 'Builder',
    pages: ['/editor', '/workitems', '/calendar', '/my-calendar', '/reminders', '/kb'],
  },
  {
    id: 'admin',
    labelKey: 'nav.group.admin',
    fallback: 'Admin',
    pages: ['/health', '/connectors', '/agents', '/messages', '/eventlog', '/event-monitor', '/workspace', '/whitelist', '/settings', '/skills'],
  },
];

export const NAV_ITEMS: Record<string, NavItem> = {
  '/my-tasks':      { labelKey: 'nav.myTasks',      fallback: 'My Tasks',   to: '/my-tasks' },
  '/monitor':       { labelKey: 'nav.overview',     fallback: 'Overview',   to: '/monitor' },
  '/cases':         { labelKey: 'nav.cases',        fallback: 'Cases',      to: '/cases' },
  '/people':        { labelKey: 'nav.people',       fallback: 'People',     to: '/people' },
  '/roles':         { labelKey: 'nav.roles',        fallback: 'Roles',      to: '/roles' },
  '/documents':     { labelKey: 'nav.documents',    fallback: 'Documents',  to: '/documents' },
  '/editor':        { labelKey: 'nav.editor',       fallback: 'Editor',     to: '/editor' },
  '/workitems':     { labelKey: 'nav.workItems',    fallback: 'Work Items', to: '/workitems' },
  '/calendar':      { labelKey: 'nav.calendar',     fallback: 'Calendar',   to: '/calendar' },
  '/my-calendar':   { labelKey: 'nav.myCalendar',   fallback: 'My Calendar', to: '/my-calendar' },
  '/reminders':     { labelKey: 'nav.reminders',    fallback: 'Reminders',  to: '/reminders' },
  '/kb':            { labelKey: 'nav.kb',           fallback: 'KB',         to: '/kb' },
  '/health':        { labelKey: 'nav.health',       fallback: 'Health',     to: '/health' },
  '/connectors':    { labelKey: 'nav.connectors',   fallback: 'IS',         to: '/connectors' },
  '/agents':        { labelKey: 'nav.agents',       fallback: 'Agents',     to: '/agents' },
  '/messages':      { labelKey: 'nav.messages',     fallback: 'Messages',   to: '/messages' },
  '/eventlog':      { labelKey: 'nav.eventlog',     fallback: 'Event Log',  to: '/eventlog' },
  '/event-monitor': { labelKey: 'nav.eventMonitor', fallback: 'Monitor',    to: '/event-monitor' },
  '/workspace':     { labelKey: 'nav.workspace',    fallback: 'Workspace',  to: '/workspace' },
  '/whitelist':     { labelKey: 'nav.access',       fallback: 'Access',     to: '/whitelist' },
  '/settings':      { labelKey: 'nav.parameters',   fallback: 'Parameters', to: '/settings' },
  '/skills':        { labelKey: 'nav.skills',       fallback: 'Skills',     to: '/skills' },
};

export function detectGroup(pathname: string): NavGroup {
  for (const group of NAV_GROUPS) {
    if (group.pages.some(page => pathname === page || pathname.startsWith(page + '/'))) {
      return group.id;
    }
  }
  return 'operator';
}
