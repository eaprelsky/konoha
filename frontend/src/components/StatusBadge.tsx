import type { WorkItemStatus } from '../api/types';

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  pending:   { bg: '#e8e8e8', color: '#333' },
  assigned:  { bg: '#0066cc', color: '#fff' },
  running:   { bg: '#f59e0b', color: '#fff' },
  completed: { bg: '#10b981', color: '#fff' },
  done:      { bg: '#10b981', color: '#fff' },
  failed:    { bg: '#ef4444', color: '#fff' },
  error:     { bg: '#ef4444', color: '#fff' },
  cancelled: { bg: '#9ca3af', color: '#fff' },
};

const STATUS_LABELS: Record<string, string> = {
  pending:   'Ожидает',
  assigned:  'Назначено',
  running:   'Выполняется',
  completed: 'Выполнено',
  done:      'Выполнено',
  failed:    'Ошибка',
  error:     'Ошибка',
  cancelled: 'Отменено',
};

export function StatusBadge({ status }: { status: string }) {
  const { bg, color } = STATUS_COLORS[status] || { bg: '#e2e8f0', color: '#475569' };
  return (
    <span
      className={`status ${status}`}
      style={{
        display: 'inline-block',
        padding: '4px 8px',
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        background: bg,
        color,
      }}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
