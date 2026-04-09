/**
 * Tour — multi-step onboarding powered by HighlightOverlay.
 * Controlled via TourContext / useTour hook.
 *
 * Issue #314.
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useHighlight, type HighlightStyle } from './HighlightOverlay';

export interface TourStep {
  selector: string;
  message: string;
  style?: HighlightStyle;
}

interface TourContextValue {
  startTour: (steps: TourStep[], onComplete?: () => void) => void;
  stopTour: () => void;
  isTourActive: boolean;
}

const TourContext = createContext<TourContextValue>({
  startTour: () => {},
  stopTour: () => {},
  isTourActive: false,
});

export function useTour() {
  return useContext(TourContext);
}

const FIRST_LOGIN_KEY = 'konoha_first_login_seen';

export function TourProvider({ children }: { children: ReactNode }) {
  const { showHighlight, hideHighlight } = useHighlight();
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [stepIdx, setStepIdx] = useState(0);
  const [onComplete, setOnComplete] = useState<(() => void) | undefined>(undefined);
  const [active, setActive] = useState(false);

  const applyStep = useCallback((stepsArr: TourStep[], idx: number) => {
    const step = stepsArr[idx];
    if (!step) return;
    showHighlight({ selector: step.selector, style: step.style ?? 'spotlight', message: undefined });
  }, [showHighlight]);

  const startTour = useCallback((newSteps: TourStep[], complete?: () => void) => {
    if (newSteps.length === 0) return;
    setSteps(newSteps);
    setStepIdx(0);
    setOnComplete(() => complete);
    setActive(true);
    applyStep(newSteps, 0);
  }, [applyStep]);

  const stopTour = useCallback(() => {
    hideHighlight();
    setActive(false);
    setSteps([]);
    setStepIdx(0);
  }, [hideHighlight]);

  const next = useCallback(() => {
    const nextIdx = stepIdx + 1;
    if (nextIdx >= steps.length) {
      stopTour();
      onComplete?.();
    } else {
      setStepIdx(nextIdx);
      applyStep(steps, nextIdx);
    }
  }, [stepIdx, steps, stopTour, onComplete, applyStep]);

  const prev = useCallback(() => {
    const prevIdx = stepIdx - 1;
    if (prevIdx < 0) return;
    setStepIdx(prevIdx);
    applyStep(steps, prevIdx);
  }, [stepIdx, steps, applyStep]);

  const skip = useCallback(() => {
    stopTour();
  }, [stopTour]);

  if (!active) {
    return (
      <TourContext.Provider value={{ startTour, stopTour, isTourActive: false }}>
        {children}
      </TourContext.Provider>
    );
  }

  const currentStep = steps[stepIdx];

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 24,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 3010,
    background: '#1e293b',
    border: '1px solid #3b82f6',
    borderRadius: 12,
    padding: '14px 20px',
    color: '#e2e8f0',
    fontSize: 13,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    minWidth: 320,
    maxWidth: 480,
  };

  const btnRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  };

  const btnStyle = (primary?: boolean): React.CSSProperties => ({
    padding: '5px 14px',
    borderRadius: 6,
    border: primary ? 'none' : '1px solid #475569',
    background: primary ? '#3b82f6' : 'transparent',
    color: primary ? '#fff' : '#94a3b8',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: primary ? 600 : 400,
  });

  const progressStyle: React.CSSProperties = {
    fontSize: 11,
    color: '#64748b',
    marginLeft: 'auto',
  };

  return (
    <TourContext.Provider value={{ startTour, stopTour, isTourActive: true }}>
      {children}
      {/* Step message overlay — sits above the highlight tooltip */}
      <div style={overlayStyle}>
        <div style={{ lineHeight: 1.5 }}>{currentStep?.message}</div>
        <div style={btnRowStyle}>
          {stepIdx > 0 && (
            <button style={btnStyle()} onClick={prev}>← Назад</button>
          )}
          <button style={btnStyle(true)} onClick={next}>
            {stepIdx < steps.length - 1 ? 'Далее →' : 'Готово ✓'}
          </button>
          <button style={btnStyle()} onClick={skip}>Пропустить</button>
          <span style={progressStyle}>{stepIdx + 1} / {steps.length}</span>
        </div>
      </div>
    </TourContext.Provider>
  );
}

/** Check and clear the first-login flag. Returns true on first login. */
export function checkFirstLogin(): boolean {
  if (localStorage.getItem(FIRST_LOGIN_KEY)) return false;
  localStorage.setItem(FIRST_LOGIN_KEY, '1');
  return true;
}
