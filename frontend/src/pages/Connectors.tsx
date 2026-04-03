import { useState, useCallback, useEffect } from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';

const styles = `
  .cn-body { padding: 20px; }
  .container { max-width: 900px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .page-header p { color: #666; font-size: 14px; margin-top: 4px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .card-name { font-size: 16px; font-weight: 600; color: #1e293b; text-transform: capitalize; }
  .health-dot { width: 10px; height: 10px; border-radius: 50%; }
  .health-ok { background: #10b981; }
  .health-err { background: #ef4444; }
  .health-unknown { background: #9ca3af; }
  .card-desc { font-size: 13px; color: #64748b; margin-bottom: 12px; }
  .check-btn { padding: 5px 12px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .check-btn:hover { background: #f8fafc; }
  .status-text { font-size: 12px; margin-top: 8px; }
  .status-ok { color: #10b981; }
  .status-err { color: #ef4444; }
  .status-unknown { color: #9ca3af; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .refresh-info { font-size: 12px; color: #999; margin-top: 16px; text-align: right; }
`;

const ADAPTER_DESCRIPTIONS: Record<string, string> = {
  telegram: 'Telegram: отправка через бота или пользовательский аккаунт',
  email: 'Email: доставка через SMTP/Mailcow',
  bitrix24: 'Интеграция с Bitrix24 CRM',
  redis: 'Redis: внутренняя шина сообщений',
};

interface ConnectorStatus { name: string; healthy: boolean | null; checking: boolean; }

export function Connectors() {
  const token = useToken();
  const [adapters, setAdapters] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ConnectorStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('-');

  const load = useCallback(() => {
    if (!token) return;
    api.adapters.list()
      .then(res => {
        setAdapters(res.adapters);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
        setLoading(false);
        // init statuses
        const init: Record<string, ConnectorStatus> = {};
        res.adapters.forEach(name => {
          init[name] = { name, healthy: null, checking: false };
        });
        setStatuses(init);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useInterval(load, 60000);

  async function checkHealth(name: string) {
    setStatuses(prev => ({ ...prev, [name]: { ...prev[name], checking: true } }));
    try {
      const res = await api.adapters.health(name);
      setStatuses(prev => ({ ...prev, [name]: { name, healthy: res.healthy, checking: false } }));
    } catch {
      setStatuses(prev => ({ ...prev, [name]: { name, healthy: false, checking: false } }));
    }
  }

  async function checkAll() {
    for (const name of adapters) { await checkHealth(name); }
  }

  return (
    <Layout activePage="connectors.html">
      <style>{styles}</style>
      <div className="cn-body">
        <div className="container">
          <div className="page-header">
            <h1>Информационные системы</h1>
            <p>Интеграции и адаптеры, доступные движку процессов.</p>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {loading && <div className="empty">Загрузка…</div>}
          {!loading && adapters.length === 0 && <div className="empty">Адаптеры не зарегистрированы.</div>}
          {adapters.length > 0 && (
            <>
              <div style={{ marginBottom: 16 }}>
                <button className="check-btn" onClick={checkAll}>Проверить все</button>
              </div>
              <div className="cards">
                {adapters.map(name => {
                  const st = statuses[name];
                  return (
                    <div className="card" key={name}>
                      <div className="card-header">
                        <span className="card-name">{name}</span>
                        <div className={`health-dot ${st?.healthy === true ? 'health-ok' : st?.healthy === false ? 'health-err' : 'health-unknown'}`} />
                      </div>
                      <div className="card-desc">{ADAPTER_DESCRIPTIONS[name] || 'Адаптер интеграции'}</div>
                      <button className="check-btn" onClick={() => checkHealth(name)} disabled={st?.checking}>
                        {st?.checking ? 'Проверка…' : 'Проверить'}
                      </button>
                      {st?.healthy !== null && (
                        <div className={`status-text ${st.healthy ? 'status-ok' : 'status-err'}`}>
                          {st.healthy ? '✓ Подключено' : '✗ Ошибка подключения'}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <div className="refresh-info">Последнее обновление: {lastUpdate}</div>
        </div>
      </div>
    </Layout>
  );
}
