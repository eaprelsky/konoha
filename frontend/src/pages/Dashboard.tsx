import { useState, useEffect } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';

const styles = `
  .container { max-width: 1200px; margin: 0 auto; padding: 28px 24px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 28px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; }
  .card h3 { font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px; }
  .card .value { font-size: 32px; font-weight: 700; color: #0f172a; }
  .card .sub { font-size: 12px; color: #94a3b8; margin-top: 4px; }
  .panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  .panel h2 { font-size: 15px; font-weight: 600; margin-bottom: 14px; }
  .links { display: flex; flex-direction: column; gap: 8px; }
  .links a { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 8px; text-decoration: none; color: #334155; background: #f8fafc; border: 1px solid #e2e8f0; font-size: 14px; }
  .links a:hover { background: #f1f5f9; border-color: #cbd5e1; }
  .links a .icon { font-size: 18px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
`;

export function Dashboard() {
  const token = useToken();
  const [wfCount, setWfCount] = useState<number | null>(null);
  const [wiCount, setWiCount] = useState<number | null>(null);

  useEffect(() => {
    if (!token) return;
    Promise.all([
      api.workflows.list().catch(() => []),
      api.workitems.list({ status: 'pending' }).catch(() => []),
      api.workitems.list().catch(() => []),
    ]).then(([wfs, pending, all]) => {
      setWfCount(Array.isArray(wfs) ? wfs.length : 0);
      setWiCount(Array.isArray(all) ? all.filter((i: any) => i.status === 'pending' || i.status === 'assigned').length : 0);
    });
  }, [token]);

  return (
    <Layout activePage="index.html" subtitle="AI Factory — coMind">
      <style>{styles}</style>
      <div className="container">
        <div className="grid" id="stats">
          <div className="card">
            <h3>Workflows</h3>
            <div className="value" id="wf-count">{wfCount ?? '—'}</div>
            <div className="sub">registered</div>
          </div>
          <div className="card">
            <h3>Active Cases</h3>
            <div className="value" id="case-count">—</div>
            <div className="sub">running</div>
          </div>
          <div className="card">
            <h3>Work Items</h3>
            <div className="value" id="wi-count">{wiCount ?? '—'}</div>
            <div className="sub">pending + assigned</div>
          </div>
        </div>
        <div className="panel">
          <h2>Navigation</h2>
          <div className="links">
            <a href="/ui/processes.html"><span className="icon">🗂</span> Process Registry — browse eEPC workflows and active cases</a>
            <a href="/ui/workitems.html"><span className="icon">✅</span> Work Items — task queue with filters and actions</a>
          </div>
        </div>
      </div>
    </Layout>
  );
}
