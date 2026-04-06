import { createContext, useContext, useState, ReactNode, useEffect } from 'react';

interface SubtitleContextValue {
  subtitle: string | undefined;
  setSubtitle: (s: string | undefined) => void;
}

const SubtitleContext = createContext<SubtitleContextValue>({
  subtitle: undefined,
  setSubtitle: () => {},
});

export function SubtitleProvider({ children }: { children: ReactNode }) {
  const [subtitle, setSubtitle] = useState<string | undefined>(undefined);
  return (
    <SubtitleContext.Provider value={{ subtitle, setSubtitle }}>
      {children}
    </SubtitleContext.Provider>
  );
}

export function useSubtitle(): string | undefined {
  return useContext(SubtitleContext).subtitle;
}

/** Call this inside a page to set the header subtitle. */
export function useSetSubtitle(value: string | undefined) {
  const { setSubtitle } = useContext(SubtitleContext);
  useEffect(() => {
    setSubtitle(value);
    return () => setSubtitle(undefined);
  }, [value]);
}
