import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { WorkItems } from '../pages/WorkItems';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <WorkItems />
    </TokenProvider>
  </StrictMode>
);
