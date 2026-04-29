/**
 * Inspector — page context collector via Symbol key (XSS-safe, closes #293)
 *
 * Uses Symbol.for('konoha.inspector') instead of window.__konoha_inspector
 * to prevent XSS via global namespace.
 */
import type { OperatorStateEnvelope } from '../operatorState';
import { summarizeOperatorState } from '../operatorState';

const INSPECTOR_KEY = Symbol.for('konoha.inspector');

class InspectorImpl {
  private _consoleLog: string[] = [];
  private _networkLog: string[] = [];
  private _actions: string[] = [];
  private _errors: string[] = [];
  private _openPanels: Set<string> = new Set();
  private _selectedElement: string | null = null;
  private _processName: string | null = null;
  private _processSchema: string | null = null;
  private _operatorState: OperatorStateEnvelope | null = null;

  constructor() {
    this._hookConsole();
    this._hookNetwork();
    this._hookWindowErrors();
  }

  private _hookConsole() {
    const origError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const line = args.map(a => String(a)).join(' ').slice(0, 200);
      this._errors.push(line);
      if (this._errors.length > 50) this._errors.shift();
      origError(...args);
    };

    const origWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      const line = '[warn] ' + args.map(a => String(a)).join(' ').slice(0, 180);
      this._consoleLog.push(line);
      if (this._consoleLog.length > 50) this._consoleLog.shift();
      origWarn(...args);
    };
  }

  private _hookNetwork() {
    const orig = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.href
          : (input as Request).url;
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const entry = `${method} ${url}`.slice(0, 120);
      this._networkLog.push(entry);
      if (this._networkLog.length > 20) this._networkLog.shift();
      return orig(input, init);
    }) as typeof fetch;
  }

  private _hookWindowErrors() {
    window.addEventListener('error', (e) => {
      const msg = `[js] ${e.message} @ ${e.filename?.split('/').pop() ?? ''}:${e.lineno}`.slice(0, 200);
      this._errors.push(msg);
      if (this._errors.length > 50) this._errors.shift();
    });
    window.addEventListener('unhandledrejection', (e) => {
      const msg = `[promise] ${String(e.reason)}`.slice(0, 200);
      this._errors.push(msg);
      if (this._errors.length > 50) this._errors.shift();
    });
  }

  registerPanel(name: string) { this._openPanels.add(name); }
  unregisterPanel(name: string) { this._openPanels.delete(name); }
  trackAction(action: string) {
    this._actions.push(action);
    if (this._actions.length > 20) this._actions.shift();
  }
  setSelectedElement(selector: string | null) { this._selectedElement = selector; }
  setProcessName(name: string | null) { this._processName = name; }
  setProcessSchema(schema: string | null) { this._processSchema = schema; }
  setOperatorState(state: OperatorStateEnvelope | null) { this._operatorState = state; }
  operatorState(): OperatorStateEnvelope | null { return this._operatorState; }

  /**
   * Returns a compact 500-800 token context summary for every /ai/chat request.
   */
  snapshot(): string {
    const lines: string[] = [];

    if (this._operatorState) {
      lines.push(summarizeOperatorState(this._operatorState));
    } else {
      lines.push(`URL: ${location.pathname}${location.search}`);
      if (this._processName) lines.push(`Process: ${this._processName}`);
      if (this._processSchema) lines.push(this._processSchema);
      if (this._selectedElement) lines.push(`Selected element: ${this._selectedElement}`);
    }

    const panels = [...this._openPanels];
    if (panels.length) lines.push(`Open panels: ${panels.join(', ')}`);

    lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`);

    const actions = this._actions.slice(-10);
    if (actions.length) {
      lines.push(`Recent actions (${actions.length}):`);
      actions.forEach(a => lines.push(`  - ${a}`));
    }

    const errors = this._errors.slice(-5);
    if (errors.length) {
      lines.push(`Errors (${errors.length}):`);
      errors.forEach(e => lines.push(`  ! ${e}`));
    }

    const network = this._networkLog.slice(-10);
    if (network.length) {
      lines.push(`Network (last ${network.length}):`);
      network.forEach(n => lines.push(`  ${n}`));
    }

    const console_ = this._consoleLog.slice(-10);
    if (console_.length) {
      lines.push(`Console (last ${console_.length}):`);
      console_.forEach(l => lines.push(`  ${l}`));
    }

    return lines.join('\n');
  }
}

function getInspector(): InspectorImpl {
  const w = window as unknown as Record<symbol, unknown>;
  if (!w[INSPECTOR_KEY]) {
    w[INSPECTOR_KEY] = new InspectorImpl();
  }
  return w[INSPECTOR_KEY] as InspectorImpl;
}

/** Public Inspector API */
export const Inspector = {
  snapshot: (): string => getInspector().snapshot(),
  operatorState: (): OperatorStateEnvelope | null => getInspector().operatorState(),
  registerPanel: (name: string): void => getInspector().registerPanel(name),
  unregisterPanel: (name: string): void => getInspector().unregisterPanel(name),
  trackAction: (action: string): void => getInspector().trackAction(action),
  setSelectedElement: (selector: string | null): void => getInspector().setSelectedElement(selector),
  setProcessName: (name: string | null): void => getInspector().setProcessName(name),
  setProcessSchema: (schema: string | null): void => getInspector().setProcessSchema(schema),
  setOperatorState: (state: OperatorStateEnvelope | null): void => getInspector().setOperatorState(state),
};
