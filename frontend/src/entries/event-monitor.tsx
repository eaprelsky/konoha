import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { I18nProvider } from '../context/I18nContext';
import { EventMonitor } from '../pages/EventMonitor';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider><TokenProvider>
      <EventMonitor />
    </TokenProvider></I18nProvider>
  </StrictMode>
);
