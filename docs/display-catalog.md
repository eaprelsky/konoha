# Display Catalog

The display catalog is the first org-scoped path for localized labels that
should be visible in product UI without changing runtime identities.

Runtime/control-plane fields stay stable:

- `id` remains the technical id used by tmux, systemd, Redis streams, and APIs.
- `name` and `display_alias` remain locale-neutral runtime defaults.
- `seed_classification` and `lifecycle_mode` remain stable enum-like metadata.

Localized UI reads use `display_catalog` entries:

| Field | Meaning |
|---|---|
| `scope` | Catalog owner, e.g. `org:default` or shared `locale` |
| `entity_type` | `agent`, `role`, `workflow`, or `ui_badge` |
| `entity_id` | Stable runtime/entity id |
| `locale` | Locale such as `ru`, `en`, or `neutral` |
| `field` | Display field such as `name`, `alias`, `label`, `description` |
| `value` | Localized display value |
| `updated_at` | ISO timestamp |

Resolver order:

1. Organization override: `scope=org:<id>`.
2. Shared locale catalog: `scope=locale`.
3. Neutral default from the entity definition.

Shared locale seed files live in `runtime-config/display-catalog.<locale>.json`.
They are product data, not control-plane logic. The runtime can also load a
different catalog directory via `KONOHA_DISPLAY_CATALOG_DIR`.

The first wired consumer is `/agents?locale=<locale>&scope=org:<id>`, which adds
a `display` projection to each agent while preserving the original runtime
fields. `GET /display-catalog` exposes the catalog entries for authenticated
clients.
