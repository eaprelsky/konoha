# Agent Naming Contract

Konoha separates runtime identity from product-facing identity and tenant-local
persona names. New workflow, UI, API, and prompt code must preserve this split.

## Fields

| Field | Meaning | Example |
|-------|---------|---------|
| `id` | Stable technical runtime id. Used by lifecycle, tmux, systemd, streams, and compatibility paths. | `sasuke` |
| `name` | Canonical portable product/corporate name. This travels across installations and stays locale-neutral in runtime defaults. | `Telegram user-account connector` |
| `display_alias` | Mutable tenant/instance callsign or persona alias. Runtime defaults stay locale-neutral; organization or locale catalogs can override it. | `User connector` |

This means `name` is not a nickname. `display_alias` is not the stable product
role. If an organization wants to call the user-account agent "Alice", only
`display_alias` changes; the canonical `name` remains
`Telegram user-account connector`.

## Related Concepts

Business process roles are separate from agents:

| Concept | Meaning | Example |
|---------|---------|---------|
| Workflow role | Responsibility in an eEPC process. | `lead_triage_specialist` |
| Assignment policy | Mapping from role to person, agent, team, or strategy. | `lead_triage_specialist -> sasuke` |
| Agent canonical name | Product-facing actor label resolved through display catalog when localized. | `Telegram user-account connector` |
| Agent alias | Local callsign/persona resolved through display catalog when localized. | `User connector` |

Workflow definitions must reference business roles, not agent ids or aliases.
Process UI can show an assignment as:

```text
Lead triage specialist -> Telegram user-account connector (alias: User connector)
```

## Current Compatibility

Naruto-style ids are still the runtime ids in production because they are wired
into systemd units, tmux sockets, Redis streams, and watchdog configs. This is a
compatibility layer, not the product vocabulary.

Compatibility-safe service/session migration is tracked separately in #620.
Until that migration lands:

- Do not rename systemd units or tmux sessions as part of product-copy cleanup.
- Do not introduce new Naruto-style names into process definitions, role ids, or
  customer-facing UI.
- Debug/operator tooling may show `id` when it is explicitly about runtime state.

## Seeded System Agents

This table describes the current compatibility fleet, not the desired product
minimum. ADR-004 narrows the mandatory target to the product assistant and
optionally the system monitor; the rest should become optional runtime workers,
connectors, or workflow-defined roles over time. Russian labels for this
deployment are loaded from `runtime-config/display-catalog.ru.json`.

| Runtime id | Canonical `name` | Default `display_alias` | Classification | Lifecycle mode |
|------------|------------------|--------------------------|----------------|----------------|
| `tsunade` | `Product assistant` | `Product assistant` | `core` | `core` |
| `naruto` | `Telegram bot connector` | `Telegram bot connector` | `connector_owned` | `connector_owned` |
| `sasuke` | `Telegram user-account connector` | `Telegram user connector` | `connector_owned` | `connector_owned` |
| `kiba` | `System monitor` | `System monitor` | `optional_worker` | `optional_on_demand` |
| `kakashi` | `SDD team lead` | `SDD team lead` | `optional_worker` | `optional_on_demand` |
| `shino` | `SDD test lead` | `SDD test lead` | `optional_worker` | `optional_on_demand` |
| `hinata` | `SDD test executor` | `SDD test executor` | `optional_worker` | `optional_on_demand` |
| `guy` | `SDD developer` | `SDD developer` | `optional_worker` | `optional_on_demand` |
| `mirai` | `External source connector` | `External source connector` | `connector_owned` | `connector_owned` |
| `jiraiya`, `ino`, `inojin` | legacy specialist actors | locale-neutral defaults | `deprecated_compat` | `deprecated` |
| `shikadai` | `Architecture reviewer` | `Architecture reviewer` | `optional_worker` | `optional_on_demand` |
