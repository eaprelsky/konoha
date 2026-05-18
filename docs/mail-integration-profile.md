# Minimal Mail Integration Profile

Issue #786 defines mail as shared infrastructure, not a Konoha-only runtime
component. The machine-readable contract is `docs/mail-integration-profile.json`.

## Shared Host Boundary

The mail host is shared by Konoha and other products, including
`moscowyachtservice`. Konoha may depend on the mail service, but must not treat
the whole mail stack as disposable Konoha runtime bloat.

The mail stack lifecycle is independent from:

- Konoha agents and watchdogs;
- MCP packs and Office/document tooling;
- application server deploys for Konoha or other products.

Application servers should use authenticated SMTP against the shared mail host.
They should not couple their process lifecycle to Konoha agents or MCP servers.

## Minimal Konoha Runtime

Konoha's minimal mail runtime is the SMTP adapter:

- adapter: `src/adapters/email.ts`
- host: `CHATBOT_SMTP_HOST`, default `mail.eaprelsky.ru`
- port: `CHATBOT_SMTP_PORT`, default `587`
- credentials: `CHATBOT_SMTP_USER`, `CHATBOT_SMTP_PASSWORD`
- required MCP servers: none

Office, document, spreadsheet, Miro, and browser MCP packs are not part of mail
delivery or ingestion. They stay disabled by default and may only be enabled by
explicit time-boxed debug profiles.

## Tenancy

Each product must have separate identities and credentials:

| Product | Domain | Scope |
| --- | --- | --- |
| `konoha` | `eaprelsky.ru` | `konoha-mail-only` |
| `moscowyachtservice` | `moscowyachtservice.ru` | `moscowyachtservice-mail-only` |

Quotas, rate limits, logs, and operational visibility must be tracked per
product/domain. Logs must include tenant, domain, message id, outbox id, and
attempt number.

## DNS/Auth Posture

Every sending domain needs:

- SPF
- DKIM
- DMARC
- MX
- bounce handling through a product-visible postmaster path

## Reliability

Workflow mail effects must route through the outbox/recovery model where
applicable. Required behavior:

- idempotency key based on tenant, workflow case, recipient, and template;
- exponential retry with max five attempts;
- dead-letter stream `mail:dead_letter`;
- alert on any dead-letter depth and on three consecutive send failures;
- fail closed when credentials are missing;
- degrade by queuing/retrying mail, not by starting optional MCP packs.

## Backup And Migration

The shared mail stack is covered by the data-store drill policy in
`docs/data-store-drill.json`. Backups must include mailbox/config state needed
to restore product identities and credential separation.

Lean Konoha cleanup may remove optional Office/document MCP tooling, but must
not remove the shared mail stack.
