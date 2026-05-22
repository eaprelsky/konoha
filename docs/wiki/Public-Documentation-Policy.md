# Public Documentation Policy

The Wiki is a curated public projection of reviewed repository documentation.
It must be safe to publish and useful to readers who do not have access to the
production environment.

## Allowed

- product overview;
- architecture concepts;
- public workflow and Action Spine vocabulary;
- local development quickstart with placeholders;
- high-level operator workflows;
- release-gate concepts without private operational details;
- tutorials that avoid real external endpoints and credentials.

## Excluded

Do not publish:

- agent memory or runtime work state;
- private classification dumps;
- private agent instructions;
- tokens, keys, session cookies, or production credentials;
- production server paths and private deployment workdirs;
- private Telegram, Yonote, Bitrix, mail, or CRM identifiers;
- raw operational logs;
- unreviewed generated dumps.

## Sync Contract

- Source pages live under `docs/wiki/`.
- The GitHub Wiki is generated from that source tree.
- Sync tooling copies only Markdown files from `docs/wiki/`.
- The sync check rejects forbidden private patterns before publishing.
- Manual Wiki edits are not source of truth and can be overwritten.
