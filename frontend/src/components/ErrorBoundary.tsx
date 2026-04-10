/**
 * ErrorBoundary — catches render errors in child subtrees (issue #347).
 * Prevents a single broken component from crashing the entire SPA.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <MyComponent />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary label="Dashboard">
 *     <Dashboard />
 *   </ErrorBoundary>
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const label = this.props.label ?? 'unknown';
    console.error(`[ErrorBoundary:${label}] uncaught render error:`, error.message, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const label = this.props.label ?? 'Компонент';
      return (
        <div style={{
          margin: 24, padding: '20px 24px',
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
        }}>
          <div style={{ fontWeight: 700, color: '#991b1b', marginBottom: 6 }}>
            Ошибка рендеринга — {label}
          </div>
          <pre style={{ fontSize: 12, color: '#7f1d1d', whiteSpace: 'pre-wrap', margin: 0 }}>
            {this.state.error.message}
          </pre>
          <button
            style={{ marginTop: 12, padding: '4px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 4, border: '1px solid #fca5a5', background: 'white', color: '#991b1b' }}
            onClick={() => this.setState({ error: null })}
          >
            Попробовать снова
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
