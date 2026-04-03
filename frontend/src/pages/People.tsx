import { useState, useCallback, useEffect } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { Person } from '../api/types';

const styles = `
  .ppl-body { padding: 20px; }
  .container { max-width: 900px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .search-input { padding: 7px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; width: 240px; }
  .search-input:focus { outline: none; border-color: #0066cc; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: middle; }
  .table tr:hover td { background: #fafafa; }
  .tg-link { color: #0066cc; text-decoration: none; font-family: monospace; font-size: 13px; }
  .tg-link:hover { text-decoration: underline; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .position { color: #64748b; font-size: 13px; }
`;

export function People() {
  const token = useToken();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    if (!token) return;
    api.people.list()
      .then(data => { setPeople(data); setError(null); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 60000);

  const q = search.toLowerCase();
  const filtered = people.filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.position || '').toLowerCase().includes(q)
  );

  return (
    <Layout activePage="people.html">
      <style>{styles}</style>
      <div className="ppl-body">
        <div className="container">
          <div className="page-header">
            <h1>Люди</h1>
            <input
              className="search-input"
              placeholder="Поиск по имени или должности…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Загрузка…</div>}
          {!loading && filtered.length === 0 && <div className="empty">Ничего не найдено.</div>}
          {!loading && filtered.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Имя</th>
                  <th>Должность</th>
                  <th>Telegram</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td><span className="position">{p.position || '—'}</span></td>
                    <td>
                      {p.tg_id ? (
                        <a
                          className="tg-link"
                          href={`tg://user?id=${p.tg_id}`}
                          title={`Telegram ID: ${p.tg_id}`}
                        >
                          @{p.id}
                        </a>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}
