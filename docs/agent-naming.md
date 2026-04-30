# Agent Naming Contract

Konoha separates runtime identity from product-facing identity and tenant-local
persona names. New workflow, UI, API, and prompt code must preserve this split.

## Fields

| Field | Meaning | Example |
|-------|---------|---------|
| `id` | Stable technical runtime id. Used by lifecycle, tmux, systemd, streams, and compatibility paths. | `sasuke` |
| `name` | Canonical portable product/corporate name. This travels across installations and should be shown as the primary agent label. | `Юзер-агент` |
| `display_alias` | Mutable tenant/instance callsign or persona alias. This can be changed per organization without changing semantics. | `Саске` |

This means `name` is not a nickname. `display_alias` is not the stable product
role. If an organization wants to call the user-account agent "Алиса", only
`display_alias` changes; the canonical `name` remains `Юзер-агент`.

## Related Concepts

Business process roles are separate from agents:

| Concept | Meaning | Example |
|---------|---------|---------|
| Workflow role | Responsibility in an eEPC process. | `lead_triage_specialist` |
| Assignment policy | Mapping from role to person, agent, team, or strategy. | `lead_triage_specialist -> sasuke` |
| Agent canonical name | Product-facing actor label. | `Юзер-агент` |
| Agent alias | Local callsign/persona. | `Саске` |

Workflow definitions must reference business roles, not agent ids or aliases.
Process UI can show an assignment as:

```text
Специалист первичной квалификации -> Юзер-агент (alias: Саске)
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
minimum. ADR-004 narrows the mandatory target to `Советник` and optionally
`Системный монитор`; the rest should become optional runtime workers,
connectors, or workflow-defined roles over time.

| Runtime id | Canonical `name` | Default `display_alias` | Lifecycle mode |
|------------|------------------|--------------------------|----------------|
| `naruto` | `Бот-агент` | `Наруто` | permanent |
| `sasuke` | `Юзер-агент` | `Саске` | permanent |
| `tsunade` | `Советник` | `Цунаде` | bus/process assistant |
| `kakashi` | `Тимлид` | `Какаши` | on-demand |
| `shino` | `Тестлид` | `Шино` | on-demand |
