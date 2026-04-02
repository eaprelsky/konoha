# Frontend Architecture — Konoha WEB

## Stack
- React 18 + TypeScript (no strict mode initially)
- Vite 5 multi-page build (3 entry points: index/processes/workitems)
- react-router-dom v6 for navigation

## Directory layout
```
frontend/
  src/
    api/        — typed API client + TypeScript types
    components/ — shared UI (Layout, Nav, Status badge, EpcRenderer)
    context/    — TokenContext (shared API token)
    hooks/      — useWorkflows, useWorkItems, useCase
    pages/      — HTML entry points (index.html, processes.html, workitems.html)
    entries/    — React entry points (dashboard.tsx, processes.tsx, workitems.tsx)
```

## Build output
`dist/ui/` → server serves via `/ui/` path (replaces public/*.html)

## Pages
1. **Dashboard** (index.html) — statistics (workflows, cases, work items count)
2. **Process Registry** (processes.html) — sidebar with process tree + SVG eEPC diagram
3. **Work Items** (workitems.html) — task table with filters, progress, details

## Component conventions
- CSS classes preserved from vanilla HTML (required for e2e tests with Playwright)
- Token via TokenContext (localStorage + prompt fallback)
- API via `src/api/client.ts` (typed fetch wrapper)
- Auto-refresh via `useInterval` hook

## Canvas (planned, issue #158)
reactflow — for visual eEPC editor
