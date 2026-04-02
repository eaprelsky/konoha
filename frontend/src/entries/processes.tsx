import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { Processes } from '../pages/Processes';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <Processes />
    </TokenProvider>
  </StrictMode>
);
