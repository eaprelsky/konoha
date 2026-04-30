# Konoha Product Roadmap

> Issue: #613 | Priority: P3 | Updated: 2026-05-01
> Living document — revisit quarterly.

## Near term (3–6 months, 2–3 developers)

- **Multitenancy**: isolate processes, agents, and data between client companies.
- **Setup wizard**: guided onboarding for a new organization.
- **Security audit**: beyond initial P0 report — penetration testing, dependency audit, OWASP coverage.
- **Monitoring/alerting**: independent from a single server — healthchecks, alert rules, incident history.
- **External-user documentation**: public docs, quickstart, API reference.

## Mid term (6–12 months)

- **Billing and subscriptions**: plan tiers, payment integration, invoice history.
- **Enterprise features**: SSO (OIDC/SAML), RBAC, audit logs, compliance reports.
- **HA/deployment evolution**: systemd/tmux → Docker Compose → Kubernetes where justified.
- **Connectors**: 1C, amoCRM, Jira, Slack, Bitrix24 (enhanced).
- **Process template marketplace**: shareable workflow templates with versioning.

## Long term (12–18 months)

- **Full SaaS**: automatic provisioning, tenant isolation, usage metering.
- **No-code process builder**: visual eEPC editor for non-technical users.
- **Russian cloud integrations**: VK Cloud, Yandex Cloud, SberCloud.
- **Partner program**: consulting companies, system integrators, reseller network.

## Out of scope (for now)

- On-premise deployment (behind NAT / air-gapped).
- Multi-language SDKs beyond TypeScript.
- Mobile native apps (PWA is acceptable).
- Blockchain / Web3 integrations.

## How to update

This roadmap is a living document. Revisit at the start of each quarter:
1. Move completed items to `docs/governance/CHANGELOG.md`.
2. Promote/demote items between horizons.
3. Add new opportunities discovered through sales conversations and customer feedback.
