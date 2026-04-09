import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { TokenProvider } from '../context/TokenContext';
import { I18nProvider } from '../context/I18nContext';
import { SubtitleProvider } from '../context/SubtitleContext';
import { Layout } from '../components/Layout';
import { HighlightProvider } from '../components/HighlightOverlay';
import { TourProvider } from '../components/Tour';
import { AssistantWidget } from '../components/AssistantWidget';

// Lazy-load all pages
const Dashboard    = lazy(() => import('../pages/Dashboard').then(m => ({ default: m.Dashboard })));
const Agents       = lazy(() => import('../pages/Agents').then(m => ({ default: m.Agents })));
const Processes    = lazy(() => import('../pages/Processes').then(m => ({ default: m.Processes })));
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

function ProtectedLayout() {
  const auth = localStorage.getItem('konoha_dash_auth') === '1';
  if (!auth) return <Navigate to="/login" replace />;
  return <Layout><Outlet /></Layout>;
}

function SuspenseWrapper({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div style={{ padding: 32, color: '#64748b' }}>Loading…</div>}>{children}</Suspense>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider><TokenProvider><SubtitleProvider><HighlightProvider><TourProvider>
      <BrowserRouter basename="/ui">
        <Routes>
          <Route path="/login" element={<SuspenseWrapper><Login /></SuspenseWrapper>} />
          <Route element={<ProtectedLayout />}>
            <Route path="/" element={<SuspenseWrapper><Dashboard /></SuspenseWrapper>} />
            <Route path="/agents" element={<SuspenseWrapper><Agents /></SuspenseWrapper>} />
            <Route path="/processes" element={<SuspenseWrapper><Processes /></SuspenseWrapper>} />
            <Route path="/editor" element={<SuspenseWrapper><ProcessEditor /></SuspenseWrapper>} />
            <Route path="/monitor" element={<SuspenseWrapper><Monitor /></SuspenseWrapper>} />
            <Route path="/calendar" element={<SuspenseWrapper><Calendar /></SuspenseWrapper>} />
            <Route path="/my-calendar" element={<SuspenseWrapper><MyCalendar /></SuspenseWrapper>} />
            <Route path="/documents" element={<SuspenseWrapper><Documents /></SuspenseWrapper>} />
            <Route path="/roles" element={<SuspenseWrapper><Roles /></SuspenseWrapper>} />
            <Route path="/people" element={<SuspenseWrapper><People /></SuspenseWrapper>} />
            <Route path="/skills" element={<SuspenseWrapper><Skills /></SuspenseWrapper>} />
            <Route path="/my-tasks" element={<SuspenseWrapper><MyTasks /></SuspenseWrapper>} />
            <Route path="/cases" element={<SuspenseWrapper><Cases /></SuspenseWrapper>} />
            <Route path="/workitems" element={<SuspenseWrapper><WorkItems /></SuspenseWrapper>} />
            <Route path="/reminders" element={<SuspenseWrapper><Reminders /></SuspenseWrapper>} />
            <Route path="/messages" element={<SuspenseWrapper><Messages /></SuspenseWrapper>} />
            <Route path="/eventlog" element={<SuspenseWrapper><EventLog /></SuspenseWrapper>} />
            <Route path="/event-monitor" element={<SuspenseWrapper><EventMonitor /></SuspenseWrapper>} />
            <Route path="/kb" element={<SuspenseWrapper><Kb /></SuspenseWrapper>} />
            <Route path="/workspace" element={<SuspenseWrapper><Workspace /></SuspenseWrapper>} />
            <Route path="/connectors" element={<SuspenseWrapper><Connectors /></SuspenseWrapper>} />
            <Route path="/health" element={<SuspenseWrapper><Health /></SuspenseWrapper>} />
            <Route path="/admin" element={<SuspenseWrapper><Admin /></SuspenseWrapper>} />
            <Route path="/whitelist" element={<SuspenseWrapper><Whitelist /></SuspenseWrapper>} />
            <Route path="/settings" element={<SuspenseWrapper><Settings /></SuspenseWrapper>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </TourProvider></HighlightProvider></SubtitleProvider></TokenProvider></I18nProvider>
    <AssistantWidget />
  </StrictMode>
);
