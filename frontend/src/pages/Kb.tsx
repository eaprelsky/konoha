import { useState, useEffect, useCallback } from 'react';
import type React from 'react';
import { Layout } from '../components/Layout';
import { useToken } from '../context/TokenContext';
import { api } from '../api/client';
import type { KbNode } from '../api/types';
import { JiraiyaPanel, JIRAIYA_CSS } from '../components/JiraiyaPanel';

const styles = `
  .kb-body { padding: 20px; }
  .container { max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: 280px 1fr; gap: 20px; }
  .panel { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); overflow: hidden; }
  .panel-header { padding: 12px 16px; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 8px; }
  .panel-header h2 { font-size: 15px; font-weight: 700; color: #333; margin: 0; flex: 1; }
  .search-row { padding: 10px 12px; border-bottom: 1px solid #eee; display: flex; gap: 6px; }
  .search-row input { flex: 1; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
  .search-row input:focus { outline: none; border-color: #6366f1; }
  .search-row button { padding: 6px 12px; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .search-row button:hover { background: #4f46e5; }
  .tree { padding: 8px; overflow-y: auto; max-height: calc(100vh - 220px); }
  .tree-dir { margin: 2px 0; }
  .tree-dir-label { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600; color: #333; user-select: none; }
  .tree-dir-label:hover { background: #f8fafc; }
  .tree-dir-children { padding-left: 16px; }
  .tree-file { padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; color: #555; display: flex; align-items: center; gap: 4px; }
  .tree-file:hover { background: #f1f5f9; }
  .tree-file.active { background: #ede9fe; color: #6366f1; font-weight: 600; }
  .tree-file .ext { font-size: 10px; color: #94a3b8; }
  .content-panel { display: flex; flex-direction: column; }
  .content-header { padding: 12px 16px; border-bottom: 1px solid #eee; display: flex; align-items: center; gap: 8px; }
  .content-path { font-size: 13px; color: #555; font-family: monospace; }
  .content-body { flex: 1; overflow: auto; }
  .content-pre { padding: 16px; margin: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: #333; font-family: 'SF Mono', 'Consolas', monospace; }
  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: #999; font-size: 14px; gap: 8px; }
  .empty-state .icon { font-size: 40px; }
  .error-msg { padding: 16px; color: #c33; font-size: 13px; background: #fee; border-radius: 4px; margin: 16px; }
  .search-results { padding: 8px; }
  .search-result { padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; color: #555; font-family: monospace; }
  .search-result:hover { background: #f1f5f9; color: #6366f1; }
`;

function TreeNode({ node, selectedPath, onSelect }: { node: KbNode; selectedPath: string | null; onSelect: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  if (node.type === 'dir') {
    return (
      <div className="tree-dir">
        <div className="tree-dir-label" onClick={() => setOpen(o => !o)}>
          <span>{open ? '▼' : '▶'}</span>
          <span>📁</span>
          <span>{node.name}</span>
        </div>
        {open && node.children && (
          <div className="tree-dir-children">
            {node.children.map(c => <TreeNode key={c.path} node={c} selectedPath={selectedPath} onSelect={onSelect} />)}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={`tree-file${selectedPath === node.path ? ' active' : ''}`}
      onClick={() => onSelect(node.path)}
    >
      <span>📄</span>
      <span>{node.name}</span>
      <span className="ext">{node.ext}</span>
    </div>
  );
}

export function Kb() {
  const token = useToken();
  const [tree, setTree] = useState<KbNode[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<{ path: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [showJiraiya, setShowJiraiya] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.kb.tree()
      .then(setTree)
      .catch(e => setTreeError(e.message));
  }, [token]);

  const openFile = useCallback((path: string) => {
    setSelectedPath(path);
    setSearchResults(null);
    setContent(null);
    setContentError(null);
    setLoadingContent(true);
    api.kb.file(path)
      .then(d => setContent(d.content))
      .catch(e => setContentError(e.message))
      .finally(() => setLoadingContent(false));
  }, []);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQ.trim()) return;
    setSearching(true);
    setSearchResults(null);
    try {
      const r = await api.kb.search(searchQ.trim());
      setSearchResults(r);
    } catch (err: any) {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <Layout activePage="kb.html">
      <style>{styles + JIRAIYA_CSS}</style>
      <div style={{ display: 'flex', height: 'calc(100vh - 64px)' }}>
      <div className="kb-body" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="container">
          <div className="panel">
            <div className="panel-header">
              <h2>Knowledge Base</h2>
              <button
                style={{ padding: '4px 10px', background: showJiraiya ? '#4f46e5' : '#1e293b', color: 'white', border: '1px solid #6366f1', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                onClick={() => setShowJiraiya(v => !v)}
              >📜 Дзирайя</button>
            </div>
            <form className="search-row" onSubmit={search}>
              <input
                placeholder="Search..."
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
              />
              <button type="submit" disabled={searching}>{searching ? '...' : 'Go'}</button>
            </form>
            {treeError && <div className="error-msg">{treeError}</div>}
            {searchResults !== null ? (
              <div className="search-results">
                <div style={{ padding: '4px 8px', fontSize: 11, color: '#888', marginBottom: 4 }}>
                  {searchResults.length} result(s) for "{searchQ}"
                  <span style={{ marginLeft: 8, cursor: 'pointer', color: '#6366f1' }} onClick={() => setSearchResults(null)}>✕ clear</span>
                </div>
                {searchResults.map(r => (
                  <div key={r.path} className="search-result" onClick={() => openFile(r.path)}>{r.path}</div>
                ))}
              </div>
            ) : (
              <div className="tree">
                {tree.map(n => <TreeNode key={n.path} node={n} selectedPath={selectedPath} onSelect={openFile} />)}
              </div>
            )}
          </div>

          <div className="panel content-panel">
            {!selectedPath ? (
              <div className="empty-state">
                <span className="icon">📚</span>
                <span>Select a file to view</span>
              </div>
            ) : (
              <>
                <div className="content-header">
                  <span className="content-path">{selectedPath}</span>
                </div>
                <div className="content-body">
                  {loadingContent && <div style={{ padding: 16, color: '#888', fontSize: 13 }}>Loading...</div>}
                  {contentError && <div className="error-msg">{contentError}</div>}
                  {content !== null && <pre className="content-pre">{content}</pre>}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {showJiraiya && (
        <JiraiyaPanel
          filePath={selectedPath}
          onFileSelect={openFile}
          onClose={() => setShowJiraiya(false)}
        />
      )}
      </div>
    </Layout>
  );
}
