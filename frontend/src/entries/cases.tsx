import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { Cases } from '../pages/Cases';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <Cases />
    </TokenProvider>
  </StrictMode>
);
