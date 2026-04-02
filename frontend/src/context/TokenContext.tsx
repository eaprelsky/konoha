import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface TokenContextValue {
  token: string;
  setToken: (t: string) => void;
}

const TokenContext = createContext<TokenContextValue>({ token: '', setToken: () => {} });

export function TokenProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      localStorage.setItem('konoha_token', fromUrl);
      return fromUrl;
    }
    return localStorage.getItem('konoha_token') || '';
  });

  useEffect(() => {
    if (!token) {
      const t = prompt('Konoha API token:') || '';
      if (t) {
        localStorage.setItem('konoha_token', t);
        setTokenState(t);
      }
    }
  }, []);

  function setToken(t: string) {
    localStorage.setItem('konoha_token', t);
    setTokenState(t);
  }

  return <TokenContext.Provider value={{ token, setToken }}>{children}</TokenContext.Provider>;
}

export function useToken(): string {
  return useContext(TokenContext).token;
}
