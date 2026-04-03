import { createContext, useContext, ReactNode } from 'react';

// Nginx injects Bearer token into /api/* automatically.
// No token prompt needed — auth is handled by login page + nginx.

interface TokenContextValue {
  token: string;
  setToken: (t: string) => void;
}

const TokenContext = createContext<TokenContextValue>({ token: 'nginx', setToken: () => {} });

export function TokenProvider({ children }: { children: ReactNode }) {
  return (
    <TokenContext.Provider value={{ token: 'nginx', setToken: () => {} }}>
      {children}
    </TokenContext.Provider>
  );
}

export function useToken(): string {
  return useContext(TokenContext).token;
}
