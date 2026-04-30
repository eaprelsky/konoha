import { describe, expect, test } from "bun:test";
import {
  CURRENT_TELEGRAM_CONNECTOR_CATALOG,
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
});
