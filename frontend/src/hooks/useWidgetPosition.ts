/**
 * Drag, resize, and position persistence for AssistantWidget floating panel.
 * Extracted from AssistantWidget.tsx (issue #448).
 */
import { useState, useRef, useCallback, useEffect } from 'react';

const POS_KEY  = 'konoha_aw_pos';
const SIZE_KEY = 'konoha_aw_size';

function defaultPos() {
  return { x: Math.max(0, window.innerWidth - 432), y: Math.max(0, window.innerHeight - 532) };
}

export interface UseWidgetPositionResult {
  pos: { x: number; y: number };
  size: { w: number; h: number };
  isMobile: boolean;
  mobileHeight: number;
  panelRef: React.RefObject<HTMLDivElement>;
  onDragStart: (e: React.MouseEvent) => void;
  onHandleTouchStart: (e: React.TouchEvent) => void;
  onHandleTouchMove: (e: React.TouchEvent) => void;
  onHandleTouchEnd: () => void;
  onSizeChange: () => void;
}

export function useWidgetPosition(isFullscreen: boolean): UseWidgetPositionResult {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try { const s = localStorage.getItem(POS_KEY); return s ? JSON.parse(s) : defaultPos(); }
    catch { return defaultPos(); }
  });
  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    try { const s = localStorage.getItem(SIZE_KEY); return s ? JSON.parse(s) : { w: 400, h: 500 }; }
    catch { return { w: 400, h: 500 }; }
  });
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [mobileHeight, setMobileHeight] = useState(() => Math.round(window.innerHeight * 0.5));

  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const touchDragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const { sx, sy, px, py } = dragRef.current;
      const newPos = { x: px + e.clientX - sx, y: py + e.clientY - sy };
      setPos(newPos);
      try { localStorage.setItem(POS_KEY, JSON.stringify(newPos)); } catch {}
    }
    function onUp() { dragRef.current = null; }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  const onSizeChange = useCallback(() => {
    if (!panelRef.current || isFullscreen) return;
    const { offsetWidth: w, offsetHeight: h } = panelRef.current;
    const newSize = { w, h };
    setSize(newSize);
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(newSize)); } catch {}
  }, [isFullscreen]);

  useEffect(() => {
    if (!panelRef.current) return;
    const ro = new ResizeObserver(onSizeChange);
    ro.observe(panelRef.current);
    return () => ro.disconnect();
  }, [onSizeChange, isFullscreen]);

  function onDragStart(e: React.MouseEvent) {
    if (isFullscreen) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
    e.preventDefault();
  }

  function onHandleTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    touchDragRef.current = { startY: t.clientY, startH: mobileHeight };
  }
  function onHandleTouchMove(e: React.TouchEvent) {
    if (!touchDragRef.current) return;
    e.preventDefault();
    const { startY, startH } = touchDragRef.current;
    const delta = startY - e.touches[0].clientY;
    const minH = Math.round(window.innerHeight * 0.25);
    const maxH = Math.round(window.innerHeight * 0.9);
    setMobileHeight(Math.max(minH, Math.min(maxH, startH + delta)));
  }
  function onHandleTouchEnd() { touchDragRef.current = null; }

  return { pos, size, isMobile, mobileHeight, panelRef, onDragStart, onHandleTouchStart, onHandleTouchMove, onHandleTouchEnd, onSizeChange };
}
