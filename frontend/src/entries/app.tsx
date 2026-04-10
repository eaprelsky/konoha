import { StrictMode, lazy, Suspense, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom';
import { TokenProvider } from '../context/TokenContext';
import { I18nProvider } from '../context/I18nContext';
import { SubtitleProvider } from '../context/SubtitleContext';
import { BrandingProvider } from '../context/BrandingContext';
import { Layout } from '../components/Layout';
import { HighlightProvider } from '../components/HighlightOverlay';
import { TourProvider } from '../components/Tour';
import { AssistantWidget } from '../components/AssistantWidget';
import { SetupWizard } from '../components/SetupWizard';
import { ErrorBoundary } from '../components/ErrorBoundary';

// Lazy-load all pages
const Dashboard    = lazy(() => import('../pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Agents       = lazy(() => import('../pages/Agents').then(m => ({ default: m.Agents })));
const ProcessEditor = lazy(() => import('../pages/ProcessEditor').then(m => ({ default: m.ProcessEditor })));
const Monitor      = lazy(() => import('../pages/Monitor').then(m => ({ default: m.Monitor })));
const Calendar     = lazy(() => import('../pages/Calendar').then(m => ({ default: m.Calendar })));
const MyCalendar   = lazy(() => import('../pages/MyCalendar').then(m => ({ default: m.MyCalendar })));
const Documents    = lazy(() => import('../pages/Documents').then(m => ({ default: m.Documents })));
const Roles        = lazy(() => import('../pages/Roles').then(m => ({ default: m.Roles })));
const People       = lazy(() => import('../pages/People').then(m => ({ default: m.People })));
const Skills       = lazy(() => import('../pages/Skills').then(m => ({ default: m.Skills })));
const MyTasks      = lazy(() => import('../pages/MyTasks').then(m => ({ default: m.MyTasks })));
const Cases        = lazy(() => import('../pages/Cases').then(m => ({ default: m.Cases })));
const WorkItems    = lazy(() => import('../pages/WorkItems').then(m => ({ default: m.WorkItems })));
const Reminders    = lazy(() => import('../pages/Reminders').then(m => ({ default: m.Reminders })));
const Messages     = lazy(() => import('../pages/Messages').then(m => ({ default: m.Messages })));
const EventLog     = lazy(() => import('../pages/EventLog').then(m => ({ default: m.EventLog })));
const EventMonitor = lazy(() => import('../pages/EventMonitor').then(m => ({ default: m.EventMonitor })));
const Kb           = lazy(() => import('../pages/Kb').then(m => ({ default: m.Kb })));
const Workspace    = lazy(() => import('../pages/Workspace').then(m => ({ default: m.Workspace })));
const Connectors   = lazy(() => import('../pages/Connectors').then(m => ({ default: m.Connectors })));
const Health       = lazy(() => import('../pages/Health').then(m => ({ default: m.Health })));
const Admin        = lazy(() => import('../pages/Admin').then(m => ({ default: m.Admin })));
const Whitelist    = lazy(() => import('../pages/Whitelist').then(m => ({ default: m.Whitelist })));
const Settings     = lazy(() => import('../pages/Settings').then(m => ({ default: m.Settings })));
const Login        = lazy(() => import('../pages/Login').then(m => ({ default: m.Login })));

function useSetupStatus() {
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/setup/status')
      .then(r => r.json())
      .then(d => setSetupDone(d.complete !== false))
      .catch(() => setSetupDone(true)); // fail open — don't block on error
  }, []);
  return { setupDone, markDone: () => setSetupDone(true) };
}

function ProtectedLayout() {
  const auth = localStorage.getItem('konoha_dash_auth') === '1';
  if (!auth) return <Navigate to="/login" replace />;
  return <Layout><Outlet /></Layout>;
}

// Wrapper to pass :id URL param as initialId to ProcessEditor (fixes #328)
function EditorWithId() {
  const { id } = useParams<{ id?: string }>();
  return <ProcessEditor initialId={id} />;
}

function SuspenseWrapper({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <ErrorBoundary label={label}>
      <Suspense fallback={<div style={{ padding: 32, color: '#64748b' }}>Loading…</div>}>{children}</Suspense>
    </ErrorBoundary>
  );
}

function App() {
  const { setupDone, markDone } = useSetupStatus();
  if (setupDone === null) return null; // loading — brief flash before status known
  if (!setupDone) return <SetupWizard onComplete={markDone} />;
  return (
    <I18nProvider><TokenProvider><SubtitleProvider><HighlightProvider><TourProvider>
      <BrowserRouter basename="/ui">
        <ErrorBoundary label="Routes">
          <Routes>
            <Route path="/login" element={<SuspenseWrapper label="Login"><Login /></SuspenseWrapper>} />
            <Route element={<ProtectedLayout />}>
              <Route path="/" element={<SuspenseWrapper label="Dashboard"><Dashboard /></SuspenseWrapper>} />
              <Route path="/agents" element={<SuspenseWrapper label="Agents"><Agents /></SuspenseWrapper>} />
              <Route path="/editor" element={<SuspenseWrapper label="ProcessEditor"><ProcessEditor /></SuspenseWrapper>} />
              <Route path="/editor/:id" element={<SuspenseWrapper label="ProcessEditor"><EditorWithId /></SuspenseWrapper>} />
              <Route path="/monitor" element={<SuspenseWrapper label="Monitor"><Monitor /></SuspenseWrapper>} />
              <Route path="/calendar" element={<SuspenseWrapper label="Calendar"><Calendar /></SuspenseWrapper>} />
              <Route path="/my-calendar" element={<SuspenseWrapper label="MyCalendar"><MyCalendar /></SuspenseWrapper>} />
              <Route path="/documents" element={<SuspenseWrapper label="Documents"><Documents /></SuspenseWrapper>} />
              <Route path="/roles" element={<SuspenseWrapper label="Roles"><Roles /></SuspenseWrapper>} />
              <Route path="/people" element={<SuspenseWrapper label="People"><People /></SuspenseWrapper>} />
              <Route path="/skills" element={<SuspenseWrapper label="Skills"><Skills /></SuspenseWrapper>} />
              <Route path="/my-tasks" element={<SuspenseWrapper label="MyTasks"><MyTasks /></SuspenseWrapper>} />
              <Route path="/cases" element={<SuspenseWrapper label="Cases"><Cases /></SuspenseWrapper>} />
              <Route path="/workitems" element={<SuspenseWrapper label="WorkItems"><WorkItems /></SuspenseWrapper>} />
              <Route path="/reminders" element={<SuspenseWrapper label="Reminders"><Reminders /></SuspenseWrapper>} />
              <Route path="/messages" element={<SuspenseWrapper label="Messages"><Messages /></SuspenseWrapper>} />
              <Route path="/eventlog" element={<SuspenseWrapper label="EventLog"><EventLog /></SuspenseWrapper>} />
              <Route path="/event-monitor" element={<SuspenseWrapper label="EventMonitor"><EventMonitor /></SuspenseWrapper>} />
              <Route path="/kb" element={<SuspenseWrapper label="Kb"><Kb /></SuspenseWrapper>} />
              <Route path="/workspace" element={<SuspenseWrapper label="Workspace"><Workspace /></SuspenseWrapper>} />
              <Route path="/connectors" element={<SuspenseWrapper label="Connectors"><Connectors /></SuspenseWrapper>} />
              <Route path="/health" element={<SuspenseWrapper label="Health"><Health /></SuspenseWrapper>} />
              <Route path="/admin" element={<SuspenseWrapper label="Admin"><Admin /></SuspenseWrapper>} />
              <Route path="/whitelist" element={<SuspenseWrapper label="Whitelist"><Whitelist /></SuspenseWrapper>} />
              <Route path="/settings" element={<SuspenseWrapper label="Settings"><Settings /></SuspenseWrapper>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
        <AssistantWidget />
      </BrowserRouter>
    </TourProvider></HighlightProvider></SubtitleProvider></TokenProvider></I18nProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrandingProvider>
      <App />
    </BrandingProvider>
  </StrictMode>
);
