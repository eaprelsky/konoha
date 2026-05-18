import { readFileSync } from "fs";
import { resolve } from "path";

export interface MailIntegrationProfile {
  schema_version: number;
  updated_for_issue: number;
  shared_mail_host: {
    service_name: string;
    host: string;
    ownership: string;
    lifecycle_boundary: string;
    backup_contract: string;
    resource_budget: {
      slice: string;
      memory_max: string;
      cpu_quota: string;
      disk_budget_gib: number;
    };
  };
  minimal_konoha_runtime: {
    enabled_adapter: string;
    required_mcp_servers: string[];
    forbidden_always_on_mcp_servers: string[];
    required_env: string[];
    default_env: Record<string, string>;
    degradation_mode: Record<string, string>;
  };
  tenants: Array<{
    product: string;
    domain: string;
    mailboxes: string[];
    credential_scope: string;
    rate_limit_per_minute: number;
    daily_quota: number;
    log_tag: string;
  }>;
  dns_auth: {
    required_records: string[];
    per_domain_policy: boolean;
    bounce_handling: {
      required: boolean;
      mailbox: string;
      log_to: string;
    };
  };
  reliability: {
    runtime_effect_model: string;
    retry: {
      max_attempts: number;
      backoff: string;
      initial_delay_sec: number;
      max_delay_sec: number;
    };
    dead_letter: {
      stream: string;
      required_fields: string[];
    };
    idempotency: {
      required: boolean;
      key_fields: string[];
    };
  };
  observability: {
    healthcheck: string[];
    metrics: string[];
    alerts: Record<string, number>;
    logs_must_include: string[];
  };
  migration_notes: string[];
}

const REQUIRED_DNS_RECORDS = ["SPF", "DKIM", "DMARC", "MX"];
const REQUIRED_PRODUCTS = ["konoha", "moscowyachtservice"];
const REQUIRED_ENV = ["CHATBOT_SMTP_HOST", "CHATBOT_SMTP_PORT", "CHATBOT_SMTP_USER", "CHATBOT_SMTP_PASSWORD"];
const OPTIONAL_TOOLING = ["excel", "word", "google-docs", "google-sheets", "miro", "miro-api", "puppeteer"];

export function loadMailIntegrationProfile(path = "docs/mail-integration-profile.json"): MailIntegrationProfile {
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as MailIntegrationProfile;
}

export function validateMailIntegrationProfile(profile: MailIntegrationProfile): string[] {
  const errors: string[] = [];
  if (profile.schema_version !== 1) errors.push(`Unsupported schema_version=${profile.schema_version}`);
  if (profile.updated_for_issue !== 786) errors.push("Mail integration profile must be tied to issue #786");
  if (profile.shared_mail_host.ownership !== "shared_infrastructure") {
    errors.push("shared_mail_host.ownership must be shared_infrastructure");
  }
  if (!profile.shared_mail_host.lifecycle_boundary.includes("independent")) {
    errors.push("shared mail lifecycle boundary must be independent from Konoha runtime");
  }
  if (profile.shared_mail_host.backup_contract !== "docs/data-store-drill.json") {
    errors.push("shared mail backup contract must point at docs/data-store-drill.json");
  }
  if (profile.shared_mail_host.resource_budget.slice !== "konoha-infra.slice") {
    errors.push("shared mail host must be budgeted as infra, not agent/runtime bloat");
  }

  if (profile.minimal_konoha_runtime.enabled_adapter !== "src/adapters/email.ts") {
    errors.push("minimal Konoha mail runtime must use src/adapters/email.ts");
  }
  if (profile.minimal_konoha_runtime.required_mcp_servers.length !== 0) {
    errors.push("minimal Konoha mail runtime must not require MCP servers");
  }
  for (const env of REQUIRED_ENV) {
    if (!profile.minimal_konoha_runtime.required_env.includes(env)) {
      errors.push(`minimal Konoha mail runtime missing required env ${env}`);
    }
  }
  for (const server of OPTIONAL_TOOLING) {
    if (!profile.minimal_konoha_runtime.forbidden_always_on_mcp_servers.includes(server)) {
      errors.push(`optional tooling must stay forbidden for always-on mail runtime: ${server}`);
    }
  }

  const products = new Set(profile.tenants.map(tenant => tenant.product));
  for (const product of REQUIRED_PRODUCTS) {
    if (!products.has(product)) errors.push(`missing tenant product ${product}`);
  }
  const scopes = new Set<string>();
  for (const tenant of profile.tenants) {
    if (scopes.has(tenant.credential_scope)) errors.push(`duplicate credential scope ${tenant.credential_scope}`);
    scopes.add(tenant.credential_scope);
    if (tenant.rate_limit_per_minute <= 0) errors.push(`${tenant.product}: rate limit must be positive`);
    if (tenant.daily_quota <= 0) errors.push(`${tenant.product}: daily quota must be positive`);
    if (!tenant.log_tag.includes(`product=${tenant.product}`)) errors.push(`${tenant.product}: log tag must include product id`);
  }

  for (const record of REQUIRED_DNS_RECORDS) {
    if (!profile.dns_auth.required_records.includes(record)) errors.push(`DNS/auth posture missing ${record}`);
  }
  if (!profile.dns_auth.per_domain_policy) errors.push("DNS/auth policy must be per-domain");
  if (!profile.dns_auth.bounce_handling.required) errors.push("bounce handling is required");

  if (profile.reliability.runtime_effect_model !== "outbox/recovery") {
    errors.push("mail runtime effects must route through outbox/recovery");
  }
  if (profile.reliability.retry.max_attempts < 3) errors.push("mail retry max_attempts must be at least 3");
  if (profile.reliability.dead_letter.stream !== "mail:dead_letter") {
    errors.push("mail dead-letter stream must be mail:dead_letter");
  }
  if (!profile.reliability.idempotency.required) errors.push("mail idempotency is required");

  for (const field of ["tenant", "domain", "message_id", "outbox_id", "attempt"]) {
    if (!profile.observability.logs_must_include.includes(field)) {
      errors.push(`mail logs must include ${field}`);
    }
  }

  return errors;
}
