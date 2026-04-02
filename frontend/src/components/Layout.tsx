import { ReactNode } from 'react';

// CSS matching vanilla HTML for e2e test compatibility
const styles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; }
  header { background: #0f172a; color: #f8fafc; padding: 14px 28px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 18px; font-weight: 600; }
  header span { font-size: 12px; color: #64748b; }
  nav { display: flex; gap: 4px; padding: 12px 24px; background: #fff; border-bottom: 1px solid #e2e8f0; flex-wrap: wrap; }
  nav a { padding: 7px 16px; border-radius: 6px; text-decoration: none; color: #475569; font-size: 14px; }
  nav a:hover, nav a.active { background: #f1f5f9; color: #0f172a; font-weight: 500; }
`;

const NAV_LINKS = [
  { href: '/ui/index.html',      label: 'Dashboard' },
  { href: '/ui/processes.html',  label: 'Processes' },
  { href: '/ui/workitems.html',  label: 'Work Items' },
  { href: '/ui/cases.html',      label: 'Cases' },
  { href: '/ui/roles.html',      label: 'Roles' },
  { href: '/ui/eventlog.html',   label: 'Event Log' },
  { href: '/ui/connectors.html', label: 'Connectors' },
];

interface LayoutProps {
  children: ReactNode;
  activePage: string; // e.g. 'index.html'
  subtitle?: string;
}

export function Layout({ children, activePage, subtitle }: LayoutProps) {
  return (
    <>
      <style>{styles}</style>
      <header>
        <h1>Konoha Workflow Engine</h1>
        {subtitle && <span>{subtitle}</span>}
      </header>
      <nav>
        {NAV_LINKS.map(({ href, label }) => (
          <a
            key={href}
            href={href}
            className={href.endsWith(activePage) ? 'active' : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      {children}
    </>
  );
}
