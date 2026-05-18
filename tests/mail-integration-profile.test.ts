import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  loadMailIntegrationProfile,
  validateMailIntegrationProfile,
} from "../src/mail-integration-profile";

const repoRoot = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

describe("minimal mail integration profile", () => {
  test("defines shared mail infrastructure, tenants, and ownership boundary", () => {
    const profile = loadMailIntegrationProfile();

    expect(validateMailIntegrationProfile(profile)).toEqual([]);
    expect(profile.shared_mail_host.ownership).toBe("shared_infrastructure");
    expect(profile.shared_mail_host.lifecycle_boundary).toContain("independent");
    expect(profile.shared_mail_host.resource_budget.slice).toBe("konoha-infra.slice");
    expect(profile.tenants.map(tenant => tenant.product).sort()).toEqual(["konoha", "moscowyachtservice"]);
    expect(new Set(profile.tenants.map(tenant => tenant.credential_scope)).size).toBe(profile.tenants.length);
  });

  test("keeps Konoha mail runtime minimal and optional tooling disabled", () => {
    const profile = loadMailIntegrationProfile();
    const optionalPacks = ["excel", "word", "google-docs", "google-sheets", "miro", "miro-api", "puppeteer"];

    expect(profile.minimal_konoha_runtime.enabled_adapter).toBe("src/adapters/email.ts");
    expect(profile.minimal_konoha_runtime.required_mcp_servers).toEqual([]);
    for (const pack of optionalPacks) {
      expect(profile.minimal_konoha_runtime.forbidden_always_on_mcp_servers).toContain(pack);
    }

    const optionalPolicy = read("docs/mcp-optional-packs-policy.md");
    expect(optionalPolicy).toContain("office-miro-debug-ttl");
    expect(optionalPolicy).toContain("Do not assign");
  });

  test("requires DNS authentication, bounce handling, retry, dead-letter, and observability", () => {
    const profile = loadMailIntegrationProfile();

    expect(profile.dns_auth.required_records.sort()).toEqual(["DKIM", "DMARC", "MX", "SPF"]);
    expect(profile.dns_auth.per_domain_policy).toBe(true);
    expect(profile.dns_auth.bounce_handling.required).toBe(true);
    expect(profile.reliability.runtime_effect_model).toBe("outbox/recovery");
    expect(profile.reliability.retry.max_attempts).toBeGreaterThanOrEqual(3);
    expect(profile.reliability.dead_letter.stream).toBe("mail:dead_letter");
    expect(profile.reliability.idempotency.required).toBe(true);
    expect(profile.observability.healthcheck).toContain("dead_letter_depth");
    expect(profile.observability.logs_must_include).toEqual(["tenant", "domain", "message_id", "outbox_id", "attempt"]);
  });

  test("documentation links the shared mail contract to adapters and resource policy", () => {
    const mailDoc = read("docs/mail-integration-profile.md");
    const adapters = read("docs/adapters.md");
    const resourcePolicy = read("docs/resource-budget-policy.md");

    expect(mailDoc).toContain("moscowyachtservice");
    expect(mailDoc).toContain("required MCP servers: none");
    expect(mailDoc).toContain("mail:dead_letter");
    expect(adapters).toContain("docs/mail-integration-profile.md");
    expect(resourcePolicy).toContain("docs/mail-integration-profile.json");
  });
});
