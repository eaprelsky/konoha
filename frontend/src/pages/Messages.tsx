import { useState, useEffect, useCallback } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { useInterval } from '../hooks/useApi';
import { api } from '../api/client';
import type { KonohaMessage, Agent } from '../api/types';

const styles = `
  .msg-body { padding: 20px; }
  .container { max-width: 1100px; margin: 0 auto; }
  .panel { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; margin-bottom: 20px; }
  .panel h2 { font-size: 18px; color: #333; margin-bottom: 16px; }
  .send-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; align-items: end; }
  .form-group { display: flex; flex-direction: column; gap: 4px; }
  .form-group label { font-size: 11px; font-weight: 700; color: #666; text-transform: uppercase; }
  .form-group input, .form-group select, .form-group textarea { padding: 8px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: #6366f1; }
  .send-row { display: flex; gap: 12px; align-items: end; margin-top: 12px; }
  .send-row .form-group { flex: 1; }
  .send-row .form-group textarea { min-height: 60px; resize: vertical; }
  .btn-send { padding: 10px 24px; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; white-space: nowrap; }
  .btn-send:hover { background: #4f46e5; }
  .btn-send:disabled { opacity: .5; cursor: not-allowed; }
  .history-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .agent-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .agent-tab { padding: 5px 14px; border-radius: 20px; border: 1px solid #ddd; background: white; cursor: pointer; font-size: 13px; color: #555; }
  .agent-tab.active { background: #6366f1; color: white; border-color: #6366f1; font-weight: 600; }
  .msg-list { display: flex; flex-direction: column; gap: 8px; max-height: 500px; overflow-y: auto; }
  .msg-item { border: 1px solid #eee; border-radius: 6px; padding: 10px 14px; }
  .msg-item.sent { border-left: 3px solid #6366f1; }
  .msg-item.received { border-left: 3px solid #10b981; }
  .msg-meta { display: flex; gap: 10px; font-size: 11px; color: #888; margin-bottom: 4px; }
  .msg-from { font-weight: 600; color: #333; }
  .msg-type { background: #f1f5f9; padding: 1px 6px; border-radius: 10px; }
  .msg-text { font-size: 14px; color: #333; white-space: pre-wrap; word-break: break-word; }
  .empty { text-align: center; padding: 30px; color: #999; font-size: 14px; }
  .error-banner { background: #fee; color: #c33; padding: 10px 14px; border-radius: 4px; margin-bottom: 12px; border-left: 4px solid #c33; font-size: 13px; }
  .success-banner { background: #f0fdf4; color: #166534; padding: 10px 14px; border-radius: 4px; margin-bottom: 12px; border-left: 4px solid #10b981; font-size: 13px; }
  .refresh-info { font-size: 11px; color: #999; text-align: right; margin-top: 8px; }
`;

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function Messages() {
  const token = useToken();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('naruto');
  const [history, setHistory] = useState<KonohaMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState('-');

  // Send form
  const [from, setFrom] = useState('admin');
  const [to, setTo] = useState('');
  const [msgType, setMsgType] = useState('message');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendOk, setSendOk] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api.agents.list().then(setAgents).catch(() => {});
  }, [token]);

  const loadHistory = useCallback(() => {
    if (!token || !selectedAgent) return;
    setLoadingHistory(true);
    api.messages.history(selectedAgent, 50)
      .then(data => {
        setHistory(data);
        setLastUpdate(new Date().toLocaleTimeString());
        setHistoryError(null);
      })
      .catch(e => setHistoryError(e.message))
      .finally(() => setLoadingHistory(false));
  }, [token, selectedAgent]);

  useEffect(() => { loadHistory(); }, [loadHistory]);
  useInterval(loadHistory, 10000);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !to.trim()) return;
    setSending(true); setSendError(null); setSendOk(null);
    try {
      const r = await api.messages.send({ from: from.trim(), to: to.trim(), text: text.trim(), type: msgType });
      setSendOk('Sent: ' + r.id);
      setText('');
      setTimeout(loadHistory, 500);
    } catch (err: any) {
      setSendError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Layout activePage="messages.html">
      <style>{styles}</style>
      <div className="msg-body">
        <div className="container">
          <div className="panel">
            <h2>Отправить сообщение</h2>
            {sendError && <div className="error-banner">{sendError}</div>}
            {sendOk && <div className="success-banner">Отправлено: {sendOk.replace('Sent: ', '')}</div>}
            <form onSubmit={send}>
              <div className="send-grid">
                <div className="form-group">
                  <label>От кого</label>
                  <input value={from} onChange={e => setFrom(e.target.value)} placeholder="admin" required />
                </div>
                <div className="form-group">
                  <label>Кому (ID агента)</label>
                  <input
                    value={to}
                    onChange={e => setTo(e.target.value)}
                    placeholder="naruto"
                    list="agent-list"
                    required
                  />
                  <datalist id="agent-list">
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </datalist>
                </div>
                <div className="form-group">
                  <label>Тип</label>
                  <select value={msgType} onChange={e => setMsgType(e.target.value)}>
                    <option value="message">message</option>
                    <option value="task">task</option>
                    <option value="result">result</option>
                    <option value="status">status</option>
                    <option value="event">event</option>
                  </select>
                </div>
              </div>
              <div className="send-row">
                <div className="form-group">
                  <label>Текст</label>
                  <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Текст сообщения…" required />
                </div>
                <button className="btn-send" type="submit" disabled={sending}>
                  {sending ? 'Отправка…' : 'Отправить'}
                </button>
              </div>
            </form>
          </div>

          <div className="panel">
            <div className="history-header">
              <h2>История сообщений</h2>
              <button style={{ padding: '5px 14px', border: '1px solid #ddd', borderRadius: 4, background: 'white', cursor: 'pointer', fontSize: 13 }} onClick={loadHistory}>
                Обновить
              </button>
            </div>
            <div className="agent-tabs">
              {['naruto', 'sasuke', 'kakashi', 'mirai', 'shino', 'hinata', 'kiba', 'guy', ...agents.map(a => a.id)
                  .filter(id => !['naruto','sasuke','kakashi','mirai','shino','hinata','kiba','guy'].includes(id))]
                .map(id => (
                  <button
                    key={id}
                    className={`agent-tab${selectedAgent === id ? ' active' : ''}`}
                    onClick={() => setSelectedAgent(id)}
                  >
                    {id}
                  </button>
                ))
              }
            </div>
            {historyError && <div className="error-banner" style={{ marginTop: 12 }}>{historyError}</div>}
            <div className="msg-list" style={{ marginTop: 14 }}>
              {loadingHistory && history.length === 0 && <div className="empty">Загрузка…</div>}
              {!loadingHistory && history.length === 0 && <div className="empty">Нет сообщений для {selectedAgent}</div>}
              {[...history].reverse().map(m => (
                <div key={m.id} className={`msg-item ${m.from === 'admin' ? 'sent' : 'received'}`}>
                  <div className="msg-meta">
                    <span className="msg-from">{m.from} → {m.to}</span>
                    <span className="msg-type">{m.type}</span>
                    <span>{formatTs(m.ts)}</span>
                    {m.channel && <span>#{m.channel}</span>}
                  </div>
                  <div className="msg-text">{m.text}</div>
                </div>
              ))}
            </div>
            <div className="refresh-info">Авто-обновление 10с · Обновлено: {lastUpdate}</div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
