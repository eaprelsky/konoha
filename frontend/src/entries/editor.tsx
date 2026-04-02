import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenProvider } from '../context/TokenContext';
import { ProcessEditor } from '../pages/ProcessEditor';
import { I18nProvider } from '../context/I18nContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider><TokenProvider>
      <ProcessEditor />
    </TokenProvider></I18nProvider>
  </StrictMode>
);
