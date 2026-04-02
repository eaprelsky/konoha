import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { Reminders } from '../pages/Reminders';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <Reminders />
    </TokenProvider>
  </StrictMode>
);
