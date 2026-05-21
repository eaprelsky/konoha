# Constructor Module

The `constructor` module (`modules/constructor/`) provides a visual workflow builder — a drag-and-drop editor for creating and editing Konoha workflows.

## Structure

```
modules/constructor/
├── frontend/   # React components for the visual editor
└── src/        # Backend routes and logic
```

## Frontend (`modules/constructor/frontend/`)

React-based visual editor integrated into the main SPA at `/ui/editor/<id>`.

Key components:
- **ProcessEditor** — main editor canvas with toolbar, palette, and inspector
- **IPECanvas** — interactive canvas for placing and connecting workflow elements
- **Inspector** — properties panel for selected elements
- **ProcessTree** — sidebar listing all workflows

Mobile support:
- Bottom sheet layout on viewports ≤ 767px
- Drag handle for resizing the sheet
- Mobile palette strip for adding elements

## Backend (`modules/constructor/src/`)

Express/Hono routes for workflow CRUD operations.
Mounted at `/workflows` in the main server (no `/api/` prefix).

Main routes:
- `GET /workflows` — list all workflows
- `GET /workflows/:id` — get workflow by ID
- `POST /workflows?draft=true` — create new workflow draft
- `POST /workflows` — create a validated workflow definition; this does not deploy runtime triggers
- `PUT /workflows/:id` — update workflow as draft or validated; updates do not imply deployment
- `/act` with `workflow.validate` — return the canonical validation receipt with blocking `errors[]`, non-blocking `warnings[]`, `readiness`, `taxonomy_version`, and stable machine-readable `code`/`class` fields for editor/operator logic. Human `message` text is display-only.
- `/act` with `workflow.patch` — apply server-side schema patches atomically. The patch contract supports `set_name`, `set_description`, `add_elements`, `update_elements`, `remove_elements`, `add_flow`, `remove_flow`, and `set_triggers`; the service validates the resulting workflow and either persists the whole patch or rejects it without partial writes. `expected_deploy_version` is the conflict guard for callers that want to avoid patching a newer deployed definition; `idempotency_key` is echoed in receipts and repeated identical add/remove operations are treated as unchanged where possible.
- `/act` with `workflow.deploy` — validate, materialize runtime start triggers, and make the workflow executable
- `DELETE /workflows/:id` — delete workflow

## Related

- `modules/workflow-engine/` — runtime execution of workflows
- `docs/ports.md` — server port assignments
