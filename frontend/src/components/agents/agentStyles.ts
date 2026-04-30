export const agentStyles = `
  .ag-body { padding: 20px; }
  .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.1); padding: 20px; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #333; font-size: 24px; }
  .btn-new { padding: 8px 18px; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .btn-new:hover { background: #4f46e5; }
  .table { width: 100%; border-collapse: collapse; }
  .table th { background: #f9f9f9; padding: 10px 12px; text-align: left; font-size: 11px; font-weight: 700; color: #666; border-bottom: 2px solid #eee; text-transform: uppercase; }
  .table td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: middle; }
  .table tr:hover td { background: #f8fafc; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot-online { background: #10b981; }
  .dot-offline { background: #9ca3af; }
  .dot-running { background: #3b82f6; }
  .dot-error { background: #ef4444; }
  .dot-starting { background: #f59e0b; }
  .dot-stopped { background: #9ca3af; }
  .actions { display: flex; gap: 5px; flex-wrap: wrap; }
  .actions button { padding: 4px 10px; border: 1px solid #ddd; background: white; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .actions button:hover { background: #f0f0f0; }
  .actions .btn-start { background: #10b981; color: white; border-color: #10b981; }
  .actions .btn-start:hover { background: #059669; }
  .actions .btn-stop { background: #f59e0b; color: white; border-color: #f59e0b; }
  .actions .btn-stop:hover { background: #d97706; }
  .actions .btn-restart { background: #3b82f6; color: white; border-color: #3b82f6; }
  .actions .btn-restart:hover { background: #2563eb; }
  .actions .btn-del { background: #ef4444; color: white; border-color: #ef4444; }
  .actions .btn-del:hover { background: #dc2626; }
  .tag { display: inline-block; padding: 1px 6px; background: #f1f5f9; border-radius: 10px; font-size: 11px; color: #475569; margin: 1px; }
  .badge-system { display: inline-block; padding: 1px 7px; background: #ede9fe; color: #5b21b6; border-radius: 8px; font-size: 10px; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .badge-external { display: inline-block; padding: 1px 7px; background: #fff7ed; color: #92400e; border-radius: 8px; font-size: 10px; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .badge-managed { display: inline-block; padding: 1px 7px; background: #f0fdf4; color: #166534; border-radius: 8px; font-size: 10px; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .badge-deprecated { display: inline-block; padding: 1px 7px; background: #f1f5f9; color: #64748b; border-radius: 8px; font-size: 10px; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .agent-row-deprecated td { color: #64748b; background: #fafafa; }
  .agent-row-deprecated img, .agent-row-deprecated td:first-child > div > div:first-child { opacity: .68; }
  .empty { text-align: center; padding: 40px; color: #999; }
  .error-banner { background: #fee; color: #c33; padding: 12px; border-radius: 4px; margin-bottom: 16px; border-left: 4px solid #c33; }
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
  .modal { background: white; border-radius: 8px; padding: 24px; width: 480px; max-width: 95vw; box-shadow: 0 20px 25px rgba(0,0,0,.15); }
  .modal h2 { margin-bottom: 18px; color: #333; }
  .form-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .form-group label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; }
  .form-group input, .form-group select, .form-group textarea { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: #6366f1; }
  .form-group textarea { resize: vertical; min-height: 80px; }
  .form-group textarea[readonly] { background: #f8fafc; color: #475569; cursor: default; }
  .form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .form-actions button { padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-submit { background: #6366f1; color: white; }
  .btn-submit:hover { background: #4f46e5; }
  .btn-cancel-f { background: #e5e7eb; color: #374151; }
  .uptime { font-size: 12px; color: #888; }
  .refresh-info { font-size: 12px; color: #999; margin-top: 12px; text-align: right; }
  .ag-filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; padding: 10px 12px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0; }
  .ag-filter-input { padding: 5px 10px; border: 1px solid #e2e8f0; border-radius: 5px; font-size: 13px; background: white; }
  .ag-filter-input:focus { outline: none; border-color: #6366f1; }
  .ag-filter-select { padding: 5px 10px; border: 1px solid #e2e8f0; border-radius: 5px; font-size: 13px; background: white; cursor: pointer; }
  .ag-filter-select:focus { outline: none; border-color: #6366f1; }
  .ag-filter-label { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
  .ag-filter-help { flex-basis: 100%; font-size: 12px; color: #64748b; line-height: 1.35; }
  /* Mobile card view (#358) */
  @media (max-width: 767px) {
    .table thead { display: none; }
    .table tr { display: block; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 10px; padding: 12px; }
    .table td { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; border: none; font-size: 13px; }
    .table td[data-label]::before { content: attr(data-label); font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; min-width: 80px; flex-shrink: 0; padding-top: 2px; }
    .table tr:hover td { background: transparent; }
    .actions { flex-wrap: nowrap; gap: 6px; margin-top: 6px; }
    .actions button { padding: 8px 14px; font-size: 13px; }
  }
`;
