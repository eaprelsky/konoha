# Konoha Plugin API

Konoha uses a three-layer plugin mechanism so domain modules can extend the
platform without creating circular dependencies. Each module implements three
interfaces: server routes, frontend navigation + pages, and MCP skills.

---

## 1. Server Routes (Hono sub-app)

### Interface

A module exports a Hono `app` instance as its default export and mounts its
own auth middleware internally.

```typescript
// modules/<name>/src/index.ts
import { Hono } from 'hono';
import { requireAuth } from '../../../src/middleware/auth';

const app = new Hono();
app.use('/my-resource/*', requireAuth);
app.route('/my-resource', myRouter);
export default app;
```

### Registration

`core/src/server.ts` mounts the module under the root path:

```typescript
import workflowEngineModule from '../../modules/workflow-engine/src';
app.route('/', workflowEngineModule);
```

### Reference implementation

`modules/workflow-engine/src/index.ts` — mounts `/workflows`, `/cases`,
`/workitems`, `/reminders` routes with auth middleware.

---

## 2. Frontend Nav Items + Pages (React plugin)

### Interface

Defined in `core/frontend/src/plugin.ts`:

```typescript
export interface NavItem {
  path: string;
  keyRu: string;
  keyEn: string;
}

export interface NavGroupDef {
  id: string;
  keyRu: string;
  keyEn: string;
  items: NavItem[];
}

export interface RouteDefinition {
  path: string;
  component: LazyExoticComponent<ComponentType<any>> | ComponentType<any>;
}

export interface KonohaFrontendPlugin {
  navGroups: NavGroupDef[];
  routes: RouteDefinition[];
}
```

### Registration

`frontend/src/plugins/registry.ts` is the **only** file that imports from
module packages. This preserves the rule: `core/frontend/src/` must not import
from `modules/`.

```typescript
// frontend/src/plugins/registry.ts
import { workflowPlugin } from '@workflow/plugin';
export const PLUGINS: KonohaFrontendPlugin[] = [workflowPlugin];
```

`frontend/src/entries/app.tsx` collects nav groups and routes:

```typescript
import { PLUGINS } from '../plugins/registry';

const pluginNavGroups = PLUGINS.flatMap(p => p.navGroups);

// In ProtectedLayout:
<PluginNavContext.Provider value={pluginNavGroups}>
  <Layout><Outlet /></Layout>
</PluginNavContext.Provider>

// In router:
{PLUGINS.flatMap(plugin =>
  plugin.routes.map(route => (
    <Route key={route.path} path={route.path}
      element={<Suspense ...><route.component /></Suspense>} />
  ))
)}
```

`core/frontend/src/components/Layout.tsx` reads plugin nav via
`PluginNavContext` and merges with its own platform nav groups (team,
settings). No direct import from modules.

### Vite path aliases

```typescript
// frontend/vite.config.ts
resolve: {
  alias: {
    '@core': resolve(__dirname, '../core/frontend/src'),
    '@workflow': resolve(__dirname, '../modules/workflow-engine/frontend'),
  }
}
```

### Reference implementation

`modules/workflow-engine/frontend/plugin.ts` — exports `workflowPlugin` with
the `processes` nav group (Каталог, Редактор, Монитор, …) and lazy-loaded
route components for all workflow pages.

---

## 3. MCP Skills

### Interface

A module exports an array of MCP tool definitions that the MCP server can
mount. Each skill is a standard MCP tool with `name`, `description`, and
`inputSchema`.

```typescript
// modules/<name>/src/mcp-skills.ts
import type { Tool } from '@modelcontextprotocol/sdk/types';

export const myModuleSkills: Tool[] = [
  {
    name: 'konoha_start_case',
    description: 'Start a new workflow case',
    inputSchema: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: 'Workflow ID' },
        village_id: { type: 'string' },
      },
      required: ['process_id', 'village_id'],
    },
  },
];
```

### Registration

`src/mcp.ts` (the MCP server entry) collects skills from all modules:

```typescript
import { myModuleSkills } from '../modules/<name>/src/mcp-skills';

const ALL_SKILLS = [...platformSkills, ...myModuleSkills];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_SKILLS,
}));
```

### Reference implementation

The workflow-engine module provides the following MCP skills (defined in
`modules/workflow-engine/src/mcp-skills.ts`):

| Skill | Description |
|---|---|
| `konoha_start_case` | Start a workflow case by process ID |
| `konoha_list_cases` | List running cases with optional status filter |
| `konoha_get_case` | Get case details and current work items |
| `konoha_complete_workitem` | Mark a work item as completed |

---

## Directory layout summary

```
core/
  src/                    ← Platform backend (Hono, Redis, agents)
  frontend/src/           ← Platform frontend (Layout, contexts, platform pages)
    plugin.ts             ← KonohaFrontendPlugin interface
    components/Layout.tsx ← Reads nav from PluginNavContext (no module imports)

modules/workflow-engine/
  src/index.ts            ← Hono sub-app (server plugin)
  frontend/plugin.ts      ← Frontend plugin (nav + routes)
  frontend/pages/         ← Workflow-domain page components
  frontend/components/    ← Workflow-domain UI components (EpcRenderer, RunOverlay)

frontend/src/
  plugins/registry.ts     ← Central plugin registry (only importer of modules/)
  entries/app.tsx         ← SPA entry: mounts plugin routes + nav context
```
