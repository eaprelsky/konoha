/**
 * HighlightOverlay — visual pointer/spotlight/outline for agent-driven UI guidance.
 * Rendered once in the app root; controlled via HighlightContext.
 *
 * Issue #313.
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';

export type HighlightStyle = 'spotlight' | 'pointer' | 'outline';

export interface HighlightState {
  selector: string;
  style: HighlightStyle;
  message?: string;
}

interface HighlightContextValue {
  highlight: HighlightState | null;
  showHighlight: (state: HighlightState) => void;
  hideHighlight: () => void;
}

const HighlightContext = createContext<HighlightContextValue>({
  highlight: null,
  showHighlight: () => {},
  hideHighlight: () => {},
});

export function useHighlight() {
  return useContext(HighlightContext);
}

export function HighlightProvider({ children }: { children: ReactNode }) {
  const [highlight, setHighlight] = useState<HighlightState | null>(null);

  const showHighlight = useCallback((state: HighlightState) => setHighlight(state), []);
  const hideHighlight = useCallback(() => setHighlight(null), []);

  return (
    <HighlightContext.Provider value={{ highlight, showHighlight, hideHighlight }}>
      {children}
      {highlight && <HighlightOverlay state={highlight} onClose={hideHighlight} />}
    </HighlightContext.Provider>
  );
}

// ── BoundingBox helpers ──────────────────────────────────────────────────────

interface BBox { x: number; y: number; w: number; h: number }

function getElementBBox(selector: string): BBox | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

function scrollToElement(selector: string) {
  const el = document.querySelector(selector);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const inView = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
  if (!inView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Tooltip auto-positioning ─────────────────────────────────────────────────

const TOOLTIP_GAP = 12;
const TOOLTIP_WIDTH = 280;

function getTooltipStyle(bbox: BBox): React.CSSProperties {
  const ww = window.innerWidth;
  const wh = window.innerHeight;
  const spaceBelow = wh - (bbox.y + bbox.h);
  const spaceAbove = bbox.y;
  const spaceRight = ww - (bbox.x + bbox.w);

  let top: number, left: number;

  if (spaceBelow >= 80 || spaceBelow > spaceAbove) {
    top = bbox.y + bbox.h + TOOLTIP_GAP;
  } else {
    top = bbox.y - TOOLTIP_GAP - 80; // approximate height
  }

  left = bbox.x + bbox.w / 2 - TOOLTIP_WIDTH / 2;
  if (left < 8) left = 8;
  if (left + TOOLTIP_WIDTH > ww - 8) left = ww - TOOLTIP_WIDTH - 8;

  if (spaceRight < TOOLTIP_WIDTH + 40 && bbox.x > TOOLTIP_WIDTH + 40) {
    left = bbox.x - TOOLTIP_WIDTH - TOOLTIP_GAP;
  }

  return { top, left, width: TOOLTIP_WIDTH };
}

// ── Main overlay component ───────────────────────────────────────────────────

const PADDING = 8;
const RADIUS = 8;

function HighlightOverlay({ state, onClose }: { state: HighlightState; onClose: () => void }) {
  const [bbox, setBbox] = useState<BBox | null>(null);
  const rafRef = useRef<number | null>(null);

  const updateBbox = useCallback(() => {
    setBbox(getElementBBox(state.selector));
  }, [state.selector]);

  useEffect(() => {
    scrollToElement(state.selector);
    // Wait for scroll to complete before measuring
    const t = setTimeout(() => {
      updateBbox();
    }, 350);
    return () => clearTimeout(t);
  }, [state.selector, updateBbox]);

  useEffect(() => {
    function onResize() {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateBbox);
    }
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [updateBbox]);

  // Raise the target element above the backdrop
  useEffect(() => {
    if (!bbox || state.style === 'outline') return;
    const el = document.querySelector<HTMLElement>(state.selector);
    if (!el) return;
    const prevPosition = el.style.position;
    const prevZIndex = el.style.zIndex;
    el.style.position = 'relative';
    el.style.zIndex = '3001';
    return () => {
      el.style.position = prevPosition;
      el.style.zIndex = prevZIndex;
    };
  }, [bbox, state.selector, state.style]);

  if (!bbox) {
    // Show a loading indicator while waiting for element
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 3000 }} onClick={onClose} />
    );
  }

  const px = bbox.x - PADDING;
  const py = bbox.y - PADDING;
  const pw = bbox.w + PADDING * 2;
  const ph = bbox.h + PADDING * 2;
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;

  const tooltipStyle: React.CSSProperties = {
    position: 'fixed',
    ...getTooltipStyle(bbox),
    background: '#1e293b',
    border: '1px solid #3b82f6',
    borderRadius: 8,
    padding: '10px 14px',
    color: '#e2e8f0',
    fontSize: 13,
    lineHeight: '1.5',
    zIndex: 3002,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    maxWidth: TOOLTIP_WIDTH,
  };

  const closeBtnStyle: React.CSSProperties = {
    position: 'absolute',
    top: 6,
    right: 8,
    background: 'none',
    border: 'none',
    color: '#94a3b8',
    cursor: 'pointer',
    fontSize: 16,
    lineHeight: 1,
    padding: '0 2px',
  };

  if (state.style === 'spotlight') {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return (
      <>
        <svg
          style={{ position: 'fixed', inset: 0, zIndex: 3000, pointerEvents: 'all' }}
          width={vw} height={vh}
          onClick={onClose}
        >
          <defs>
            <mask id="hl-spotlight-mask">
              <rect width={vw} height={vh} fill="white" />
              <rect x={px} y={py} width={pw} height={ph} rx={RADIUS} ry={RADIUS} fill="black" />
            </mask>
          </defs>
          <rect
            width={vw} height={vh}
            fill="rgba(0,0,0,0.65)"
            mask="url(#hl-spotlight-mask)"
          />
          <rect
            x={px} y={py} width={pw} height={ph} rx={RADIUS} ry={RADIUS}
            fill="none"
            stroke="#3b82f6"
            strokeWidth="2"
          />
        </svg>
        {state.message && (
          <div style={tooltipStyle}>
            <button style={closeBtnStyle} onClick={onClose}>×</button>
            {state.message}
          </div>
        )}
      </>
    );
  }

  if (state.style === 'pointer') {
    return (
      <>
        <div style={{ position: 'fixed', inset: 0, zIndex: 3000 }} onClick={onClose} />
        <style>{`
          @keyframes hl-pulse {
            0%   { transform: translate(-50%, -50%) scale(1);   opacity: 0.8; }
            50%  { transform: translate(-50%, -50%) scale(1.4); opacity: 0.4; }
            100% { transform: translate(-50%, -50%) scale(1);   opacity: 0.8; }
          }
          .hl-pointer-ring {
            position: fixed;
            left: ${cx}px;
            top: ${cy}px;
            width: ${Math.max(pw, ph) + 16}px;
            height: ${Math.max(pw, ph) + 16}px;
            border: 2.5px solid #3b82f6;
            border-radius: 50%;
            animation: hl-pulse 1.5s ease-in-out infinite;
            z-index: 3001;
            pointer-events: none;
            box-shadow: 0 0 0 4px rgba(59,130,246,0.2);
          }
        `}</style>
        <div className="hl-pointer-ring" />
        {state.message && (
          <div style={tooltipStyle}>
            <button style={closeBtnStyle} onClick={onClose}>×</button>
            {state.message}
          </div>
        )}
      </>
    );
  }

  // outline mode
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 3000 }} onClick={onClose} />
      <div style={{
        position: 'fixed',
        left: px,
        top: py,
        width: pw,
        height: ph,
        borderRadius: RADIUS,
        boxShadow: '0 0 0 2px #3b82f6, 0 0 16px rgba(59,130,246,0.4)',
        zIndex: 3001,
        pointerEvents: 'none',
      }} />
      {state.message && (
        <div style={tooltipStyle}>
          <button style={closeBtnStyle} onClick={onClose}>×</button>
          {state.message}
        </div>
      )}
    </>
  );
}
