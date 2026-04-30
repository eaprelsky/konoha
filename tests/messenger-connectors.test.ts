import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CURRENT_TELEGRAM_CONNECTOR_CATALOG,
  classifyMessengerRoutingInput,
  extractCommand,
  getMessengerConnectorCatalog,
  loadMessengerConnectorCatalogFromFile,
  MESSENGER_CONNECTOR_CATALOG_PATH_ENV,
  resolveMessengerWorkflowIds,
  resolveMessengerTargets,
  validateMessengerConnectorCatalog,
  type MessengerConnectorCatalog,
} from "../src/messenger-connectors";

describe("messenger connector model", () => {
  test("describes current Telegram compatibility streams without renaming runtime ids", () => {
    expect(validateMessengerConnectorCatalog(CURRENT_TELEGRAM_CONNECTOR_CATALOG)).toEqual([]);

    const connector = CURRENT_TELEGRAM_CONNECTOR_CATALOG.connectors[0];
    const bot = CURRENT_TELEGRAM_CONNECTOR_CATALOG.endpoints.find(endpoint => endpoint.kind === "bot");
    const user = CURRENT_TELEGRAM_CONNECTOR_CATALOG.endpoints.find(endpoint => endpoint.kind === "user_account");

    expect(connector.compatibility_runtime_ids).toEqual(["naruto", "sasuke"]);
    expect(bot).toMatchObject({
      endpoint_id: "telegram-bot-naruto",
      compatibility_agent_id: "naruto",
    });
    expect(bot?.inbound_streams.map(stream => stream.stream)).toContain("telegram:bot:incoming");
    expect(user).toMatchObject({
      endpoint_id: "telegram-user-sasuke",
      compatibility_agent_id: "sasuke",
    });
    expect(user?.inbound_streams.map(stream => stream.stream)).toContain("telegram:incoming");
  });

  test("keeps compatibility routes scoped to their Telegram endpoint", () => {
    expect(resolveMessengerTargets(CURRENT_TELEGRAM_CONNECTOR_CATALOG, {
      endpoint_id: "telegram-bot-naruto",
      chat_ref: "chat:group",
      chat_type: "group",
    })).toEqual([{ target_type: "agent", target_id: "naruto" }]);

    expect(resolveMessengerTargets(CURRENT_TELEGRAM_CONNECTOR_CATALOG, {
      endpoint_id: "telegram-bot-naruto",
      chat_ref: "chat:direct",
      chat_type: "direct",
    })).toEqual([
      { target_type: "workflow", target_id: "telegram-lead-intake" },
      { target_type: "agent", target_id: "naruto" },
    ]);

    expect(resolveMessengerTargets(CURRENT_TELEGRAM_CONNECTOR_CATALOG, {
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "chat:group",
      chat_type: "group",
    })).toEqual([{ target_type: "agent", target_id: "sasuke" }]);
  });

  test("resolves explicit workflow scope for bound Telegram chats only", () => {
    expect(resolveMessengerWorkflowIds(CURRENT_TELEGRAM_CONNECTOR_CATALOG, {
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "-4982206077",
      chat_type: "group",
    })).toEqual(["lead-qualification"]);

    expect(resolveMessengerWorkflowIds(CURRENT_TELEGRAM_CONNECTOR_CATALOG, {
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "unbound-chat",
      chat_type: "group",
    })).toBeNull();
  });

  test("routes one messenger connector to multiple workflows and agents", () => {
    const catalog: MessengerConnectorCatalog = {
      schema_version: 1,
      connectors: [{
        connector_id: "telegram-sales",
        provider: "telegram",
        label: "Sales Telegram",
        enabled: true,
        endpoint_ids: ["bot-a", "user-b"],
      }],
      endpoints: [
        {
          endpoint_id: "bot-a",
          connector_id: "telegram-sales",
          kind: "bot",
          label: "Lead bot",
          account_ref: "env:LEAD_BOT_TOKEN",
          inbound_streams: [{ stream: "telegram:lead_bot:incoming", group: "lead-router", direction: "inbound" }],
        },
        {
          endpoint_id: "user-b",
          connector_id: "telegram-sales",
          kind: "user_account",
          label: "Sales user account",
          account_ref: "profile:sales-user",
          inbound_streams: [{ stream: "telegram:sales_user:incoming", group: "sales-router", direction: "inbound" }],
        },
      ],
      routing_policies: [{
        policy_id: "sales-routing",
        connector_id: "telegram-sales",
        strategy: "hybrid",
        default_targets: [{ target_type: "role", target_id: "sales_operator" }],
        enabled_workflow_ids: ["lead-intake", "support-triage"],
        rules: [{
          rule_id: "direct-lead",
          description: "Direct bot chats start lead intake and can delegate to a triage agent.",
          match: { chat_type: "direct" },
          targets: [
            { target_type: "workflow", target_id: "lead-intake" },
            { target_type: "agent", target_id: "triage-agent" },
          ],
          enabled_workflow_ids: ["lead-intake"],
        }],
      }],
      chat_bindings: [{
        binding_id: "lead-direct",
        connector_id: "telegram-sales",
        endpoint_id: "bot-a",
        chat_ref: "chat:123",
        chat_type: "direct",
        routing_policy_id: "sales-routing",
        enabled_workflow_ids: ["lead-intake"],
        enabled: true,
      }],
    };

    expect(validateMessengerConnectorCatalog(catalog)).toEqual([]);
    expect(resolveMessengerTargets(catalog, {
      endpoint_id: "bot-a",
      chat_ref: "chat:123",
      chat_type: "direct",
    })).toEqual([
      { target_type: "workflow", target_id: "lead-intake" },
      { target_type: "agent", target_id: "triage-agent" },
    ]);
  });

  test("classifies commands deterministically before rule matching", () => {
    expect(extractCommand("/lead Need proposal")).toBe("lead");
    expect(extractCommand("/lead@SomeBot Need proposal")).toBe("lead");
    expect(extractCommand("plain text")).toBeUndefined();

    const classified = classifyMessengerRoutingInput({
      endpoint_id: "bot-a",
      chat_ref: "chat:123",
      text: "/lead Need proposal",
      event_kind: "message",
    });

    expect(classified).toMatchObject({
      message_type: "command",
      command: "lead",
    });
  });

  test("uses deterministic message type and command rules to narrow workflow scope", () => {
    const catalog: MessengerConnectorCatalog = {
      schema_version: 1,
      connectors: [{
        connector_id: "telegram-router",
        provider: "telegram",
        label: "Router Telegram",
        enabled: true,
        endpoint_ids: ["router-bot"],
      }],
      endpoints: [{
        endpoint_id: "router-bot",
        connector_id: "telegram-router",
        kind: "bot",
        label: "Router bot",
        account_ref: "env:ROUTER_BOT_TOKEN",
        inbound_streams: [{ stream: "telegram:router:incoming", group: "router", direction: "inbound" }],
      }],
      routing_policies: [{
        policy_id: "router-policy",
        connector_id: "telegram-router",
        strategy: "workflow_trigger",
        default_targets: [{ target_type: "workflow", target_id: "general-intake" }],
        enabled_workflow_ids: ["general-intake"],
        rules: [{
          rule_id: "lead-command",
          description: "Route explicit lead commands to sales intake.",
          match: { message_type: "command", command: "lead" },
          targets: [{ target_type: "workflow", target_id: "lead-intake" }],
          enabled_workflow_ids: ["lead-intake"],
        }],
      }],
      chat_bindings: [{
        binding_id: "router-default",
        connector_id: "telegram-router",
        endpoint_id: "router-bot",
        chat_ref: "*",
        chat_type: "unknown",
        routing_policy_id: "router-policy",
        enabled_workflow_ids: [],
        enabled: true,
      }],
    };

    expect(resolveMessengerWorkflowIds(catalog, {
      endpoint_id: "router-bot",
      chat_ref: "chat:any",
      text: "/lead Need proposal",
      event_kind: "message",
    })).toEqual(["lead-intake"]);

    expect(resolveMessengerWorkflowIds(catalog, {
      endpoint_id: "router-bot",
      chat_ref: "chat:any",
      text: "hello",
      event_kind: "message",
    })).toEqual(["general-intake"]);
  });

  test("loads a validated runtime catalog override from JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "konoha-messenger-catalog-"));
    const path = join(dir, "catalog.json");
    const catalog: MessengerConnectorCatalog = {
      schema_version: 1,
      connectors: [{
        connector_id: "telegram-override",
        provider: "telegram",
        label: "Runtime Telegram",
        enabled: true,
        endpoint_ids: ["runtime-bot"],
      }],
      endpoints: [{
        endpoint_id: "runtime-bot",
        connector_id: "telegram-override",
        kind: "bot",
        label: "Runtime bot",
        account_ref: "env:RUNTIME_BOT_TOKEN",
        inbound_streams: [{ stream: "telegram:runtime:incoming", group: "runtime-router", direction: "inbound" }],
        outbound_adapter: "telegram",
      }],
      routing_policies: [{
        policy_id: "runtime-routing",
        connector_id: "telegram-override",
        strategy: "workflow_trigger",
        default_targets: [{ target_type: "workflow", target_id: "runtime-workflow" }],
        enabled_workflow_ids: ["runtime-workflow"],
        rules: [],
      }],
      chat_bindings: [{
        binding_id: "runtime-chat",
        connector_id: "telegram-override",
        endpoint_id: "runtime-bot",
        chat_ref: "chat:runtime",
        chat_type: "direct",
        routing_policy_id: "runtime-routing",
        enabled_workflow_ids: ["runtime-workflow"],
        enabled: true,
      }],
    };
    writeFileSync(path, JSON.stringify(catalog));

    expect(loadMessengerConnectorCatalogFromFile(path)).toMatchObject({
      connectors: [{ connector_id: "telegram-override" }],
    });
    expect(getMessengerConnectorCatalog({ [MESSENGER_CONNECTOR_CATALOG_PATH_ENV]: path })).toMatchObject({
      connectors: [{ connector_id: "telegram-override" }],
    });
  });

  test("rejects invalid runtime catalog references", () => {
    const dir = mkdtempSync(join(tmpdir(), "konoha-messenger-catalog-"));
    const path = join(dir, "bad-catalog.json");
    writeFileSync(path, JSON.stringify({
      ...CURRENT_TELEGRAM_CONNECTOR_CATALOG,
      chat_bindings: [{
        ...CURRENT_TELEGRAM_CONNECTOR_CATALOG.chat_bindings[0],
        routing_policy_id: "missing-policy",
      }],
    }));

    expect(() => loadMessengerConnectorCatalogFromFile(path)).toThrow("missing policy");
  });
});
