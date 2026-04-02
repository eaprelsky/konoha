import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { Roles } from '../pages/Roles';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <Roles />
    </TokenProvider>
  </StrictMode>
);
