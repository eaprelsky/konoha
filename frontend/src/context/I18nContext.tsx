import { createContext, useContext, useState, type ReactNode } from 'react';
import { translations, type Lang } from '../i18n/translations';

interface I18nContextType {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, fallback?: string) => string;
}

const I18nContext = createContext<I18nContextType>({
  lang: 'en',
  setLang: () => {},
  t: (k, fb) => fb || k,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const stored = (typeof localStorage !== 'undefined' ? localStorage.getItem('konoha_lang') : null) as Lang | null;
  const [lang, setLangState] = useState<Lang>(stored || 'en');

  function setLang(l: Lang) {
    setLangState(l);
    localStorage.setItem('konoha_lang', l);
  }

  function t(key: string, fallback?: string): string {
    return translations[lang]?.[key] ?? translations['en']?.[key] ?? fallback ?? key;
  }

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() { return useContext(I18nContext); }
