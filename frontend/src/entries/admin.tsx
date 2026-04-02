import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { Admin } from '../pages/Admin';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <Admin />
    </TokenProvider>
  </StrictMode>
);
