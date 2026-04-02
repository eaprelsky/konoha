import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { Agents } from '../pages/Agents';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <Agents />
    </TokenProvider>
  </StrictMode>
);
