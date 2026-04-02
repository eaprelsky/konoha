import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { Documents } from '../pages/Documents';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <Documents />
    </TokenProvider>
  </StrictMode>
);
