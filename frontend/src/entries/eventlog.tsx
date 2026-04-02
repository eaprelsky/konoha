import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { EventLog } from '../pages/EventLog';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TokenProvider>
      <EventLog />
    </TokenProvider>
  </StrictMode>
);
