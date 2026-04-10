/**
 * Workflow-engine frontend plugin.
 * Registers the "Процессы / Processes" nav group and all workflow routes.
 */
import { lazy } from 'react';
import type { KonohaFrontendPlugin } from '@core/plugin';

const ProcessEditor = lazy(() => import('./pages/ProcessEditor').then(m => ({ default: m.ProcessEditor })));
const Monitor      = lazy(() => import('./pages/Monitor').then(m => ({ default: m.Monitor })));
const Calendar     = lazy(() => import('./pages/Calendar').then(m => ({ default: m.Calendar })));
const MyCalendar   = lazy(() => import('./pages/MyCalendar').then(m => ({ default: m.MyCalendar })));
const Documents    = lazy(() => import('./pages/Documents').then(m => ({ default: m.Documents })));
const Cases        = lazy(() => import('./pages/Cases').then(m => ({ default: m.Cases })));
const WorkItems    = lazy(() => import('./pages/WorkItems').then(m => ({ default: m.WorkItems })));
const Reminders    = lazy(() => import('./pages/Reminders').then(m => ({ default: m.Reminders })));
const MyTasks      = lazy(() => import('./pages/MyTasks').then(m => ({ default: m.MyTasks })));
const Processes    = lazy(() => import('./pages/Processes').then(m => ({ default: m.Processes })));

export const workflowPlugin: KonohaFrontendPlugin = {
  navGroups: [
    {
      id: 'processes',
      keyRu: 'Процессы',
      keyEn: 'Processes',
      items: [
        { path: '/processes',   keyRu: 'Каталог',       keyEn: 'Catalog'    },
        { path: '/editor',      keyRu: 'Редактор',      keyEn: 'Editor'     },
        { path: '/monitor',     keyRu: 'Монитор',       keyEn: 'Monitor'    },
        { path: '/documents',   keyRu: 'Документы',     keyEn: 'Documents'  },
        { path: '/cases',       keyRu: 'Прогоны',       keyEn: 'Cases'      },
        { path: '/workitems',   keyRu: 'Задачи',        keyEn: 'Work Items' },
        { path: '/my-tasks',    keyRu: 'Мои задачи',    keyEn: 'My Tasks'   },
        { path: '/my-calendar', keyRu: 'Мой календарь', keyEn: 'My Cal'     },
        { path: '/calendar',    keyRu: 'Календарь',     keyEn: 'Calendar'   },
        { path: '/reminders',   keyRu: 'Напоминания',   keyEn: 'Reminders'  },
      ],
    },
  ],
  routes: [
    { path: '/processes',   component: Processes   },
    { path: '/editor',      component: ProcessEditor },
    { path: '/monitor',     component: Monitor     },
    { path: '/calendar',    component: Calendar    },
    { path: '/my-calendar', component: MyCalendar  },
    { path: '/documents',   component: Documents   },
    { path: '/my-tasks',    component: MyTasks     },
    { path: '/cases',       component: Cases       },
    { path: '/workitems',   component: WorkItems   },
    { path: '/reminders',   component: Reminders   },
  ],
};
