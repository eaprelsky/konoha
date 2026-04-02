import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { Dashboard } from '../pages/Dashboard';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <Dashboard />
    </TokenProvider>
  </StrictMode>
);
