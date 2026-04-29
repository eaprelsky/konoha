# Canonical Agent-Readable State Surface

Issue: `#530`

## Purpose

This document defines the canonical state surface exposed to assistant operators for the process editor and surrounding shell.

The assistant must reason over this state contract, not over raw DOM structure.

## Contract

Version: `konoha.operator_state/v1`

Top-level shape:

```json
{
  "version": "konoha.operator_state/v1",
  "captured_at": "2026-04-16T08:00:00.000Z",
  "current_view": {
    "id": "process_editor",
    "kind": "process_editor",
    "route": "/ui/editor/order-flow",
    "title": "Order Flow (order-flow)",
    "read_only": false,
    "viewport": {
      "width": 1280,
      "height": 720,
      "device_pixel_ratio": 2,
      "is_mobile": false
    }
  },
  "current_process": {
    "workflow": {},
    "selection": {},
    "pending": {},
    "changes": {},
    "affordances": {},
    "registries": {}
  }
}
```

## Semantics

- `current_view`: canonical shell/view identity, independent of DOM selectors
- `current_process.workflow`: what exists now in the editor, including elements, edges, canvas position, and breadcrumb context
- `current_process.selection`: what is selected or being edited right now
- `current_process.pending`: what is pending right now, including save state, trigger resolution, and draft warnings
- `current_process.changes`: what changed locally and whether the editor has unsaved local work
- `current_process.affordances`: what is editable right now for the operator
- `current_process.affordances.actions`: canonical action-discovery layer for the current context; every entry must reference a concrete `action_id`
- `current_process.registries`: adjacent state needed for reasoning about role/document/system picks without scraping sidebars

## Affordance descriptors

Each affordance action descriptor must expose:

- `action_id`: canonical action-registry id such as `workflow.update` or `trigger.set`
- `availability`: `available` or `unavailable`
- `reason`: explicit blocked/unavailable reason when not available
- `suggested_args`: context-derived arguments the assistant can start from
- `scope`: where the affordance comes from (`workflow`, `selection`, `canvas`, `view`)

On the server prompt path, affordances are enriched with registry metadata:

- `registry.autonomy`
- `registry.current_endpoint`
- `registry.arg_names`
- `risk_level`

This keeps discovery tied to canonical actions, not to prompt prose or DOM guesswork.

## Freshness and invalidation

- The frontend rebuilds `operator_state` from canonical editor state on each relevant state change.
- The server treats `operator_state` as request-scoped input captured at send time.
- Any navigation, workflow load, mutation, or editor-state change invalidates the previous snapshot.
- The assistant must prefer the latest provided `operator_state` over older chat history assumptions.

## Separation of concerns

- Human-facing DOM remains an interaction surface.
- `operator_state` is the assistant-visible canonical state surface.
- Telemetry-like context such as console/network/error logs remains separate and is sent as auxiliary inspector telemetry, not as the main state contract.
