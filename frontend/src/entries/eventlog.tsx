import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { EventLog } from '../pages/EventLog';
import { I18nProvider } from '../context/I18nContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider><TokenProvider>
      <EventLog />
    </TokenProvider></I18nProvider>
  </StrictMode>
);
