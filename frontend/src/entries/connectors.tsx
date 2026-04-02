import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { Connectors } from '../pages/Connectors';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <Connectors />
    </TokenProvider>
  </StrictMode>
);
