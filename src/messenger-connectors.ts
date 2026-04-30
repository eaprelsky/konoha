export type MessengerProvider = "telegram" | "whatsapp" | "email" | "custom";
export type MessengerEndpointKind = "bot" | "user_account" | "business_account" | "webhook";
export type MessengerChatType = "direct" | "group" | "channel" | "unknown";
export type MessengerRouteTargetType = "workflow" | "agent" | "role";
export type MessengerRoutingStrategy = "workflow_trigger" | "agent_delegate" | "hybrid";

export interface MessengerStreamBinding {
  stream: string;
  group: string;
  consumer?: string;
  direction: "inbound" | "outbound" | "reaction" | "audit";
  event_type?: string;
}

export interface MessengerConnector {
  connector_id: string;
  provider: MessengerProvider;
  label: string;
  enabled: boolean;
  endpoint_ids: string[];
  compatibility_runtime_ids?: string[];
  notes?: string;
}

export interface MessengerEndpoint {
  endpoint_id: string;
  connector_id: string;
  kind: MessengerEndpointKind;
  label: string;
  account_ref: string;
  inbound_streams: MessengerStreamBinding[];
  outbound_adapter?: string;
  compatibility_agent_id?: string;
}

export interface MessengerRouteTarget {
  target_type: MessengerRouteTargetType;
  target_id: string;
}

export interface MessengerRoutingRule {
  rule_id: string;
  description: string;
  match: {
    chat_id?: string;
    chat_type?: MessengerChatType;
    message_type?: string;
    command?: string;
  };
  targets: MessengerRouteTarget[];
  enabled_workflow_ids?: string[];
}

export interface MessengerRoutingPolicy {
  policy_id: string;
  connector_id: string;
  strategy: MessengerRoutingStrategy;
  default_targets: MessengerRouteTarget[];
  enabled_workflow_ids: string[];
  rules: MessengerRoutingRule[];
}

export interface MessengerChatBinding {
  binding_id: string;
  connector_id: string;
  endpoint_id: string;
  chat_ref: string;
  chat_type: MessengerChatType;
  routing_policy_id: string;
  enabled_workflow_ids: string[];
  enabled: boolean;
}

export interface MessengerConnectorCatalog {
  schema_version: 1;
  connectors: MessengerConnector[];
  endpoints: MessengerEndpoint[];
  routing_policies: MessengerRoutingPolicy[];
  chat_bindings: MessengerChatBinding[];
}

export const CURRENT_TELEGRAM_CONNECTOR_CATALOG: MessengerConnectorCatalog = {
  schema_version: 1,
  connectors: [
    {
      connector_id: "telegram-main",
      provider: "telegram",
      label: "Telegram compatibility connector",
      enabled: true,
      endpoint_ids: ["telegram-bot-naruto", "telegram-user-sasuke"],
      compatibility_runtime_ids: ["naruto", "sasuke"],
      notes: "Compatibility catalog only; runtime ids, streams, and services are unchanged.",
    },
  ],
  endpoints: [
    {
      endpoint_id: "telegram-bot-naruto",
      connector_id: "telegram-main",
      kind: "bot",
      label: "Telegram bot endpoint",
      account_ref: "env:TELEGRAM_BOT_TOKEN",
      inbound_streams: [
        {
          stream: "telegram:bot:incoming",
          group: "naruto",
          consumer: "naruto-lifecycle-watchdog",
          direction: "inbound",
          event_type: "telegram.message.received",
        },
      ],
      outbound_adapter: "telegram",
      compatibility_agent_id: "naruto",
    },
    {
      endpoint_id: "telegram-user-sasuke",
      connector_id: "telegram-main",
      kind: "user_account",
      label: "Telegram user-account endpoint",
      account_ref: "profile:telethon-user-account",
      inbound_streams: [
        {
          stream: "telegram:incoming",
          group: "sasuke",
          consumer: "sasuke-lifecycle-watchdog",
          direction: "inbound",
          event_type: "telegram.message.received",
        },
        {
          stream: "telegram:reaction_updates",
          group: "sasuke-reactions",
          consumer: "sasuke-reaction-lifecycle-watchdog",
          direction: "reaction",
          event_type: "telegram.reaction.received",
        },
      ],
      outbound_adapter: "telegram",
      compatibility_agent_id: "sasuke",
    },
  ],
  routing_policies: [
    {
      policy_id: "telegram-compat-routing",
      connector_id: "telegram-main",
      strategy: "hybrid",
      default_targets: [
        { target_type: "agent", target_id: "naruto" },
        { target_type: "agent", target_id: "sasuke" },
      ],
      enabled_workflow_ids: ["telegram-lead-intake"],
      rules: [
        {
          rule_id: "bot-owner-escalation",
          description: "Bot endpoint can start workflow triggers or delegate operator replies to Naruto.",
          match: { chat_type: "direct" },
          targets: [
            { target_type: "workflow", target_id: "telegram-lead-intake" },
            { target_type: "agent", target_id: "naruto" },
          ],
          enabled_workflow_ids: ["telegram-lead-intake"],
        },
        {
          rule_id: "user-account-routing",
          description: "User-account endpoint routes direct/group messages through Sasuke compatibility runtime.",
          match: { chat_type: "unknown" },
          targets: [{ target_type: "agent", target_id: "sasuke" }],
        },
      ],
    },
  ],
  chat_bindings: [
    {
      binding_id: "telegram-bot-default",
      connector_id: "telegram-main",
      endpoint_id: "telegram-bot-naruto",
      chat_ref: "*",
      chat_type: "unknown",
      routing_policy_id: "telegram-compat-routing",
      enabled_workflow_ids: ["telegram-lead-intake"],
      enabled: true,
    },
    {
      binding_id: "telegram-user-default",
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "*",
      chat_type: "unknown",
      routing_policy_id: "telegram-compat-routing",
      enabled_workflow_ids: [],
      enabled: true,
    },
  ],
};

export function listMessengerConnectorCatalogs(): MessengerConnectorCatalog[] {
  return [CURRENT_TELEGRAM_CONNECTOR_CATALOG];
}

export function validateMessengerConnectorCatalog(catalog: MessengerConnectorCatalog): string[] {
  const errors: string[] = [];
  const connectorIds = new Set(catalog.connectors.map(connector => connector.connector_id));
  const endpointIds = new Set(catalog.endpoints.map(endpoint => endpoint.endpoint_id));
  const policyIds = new Set(catalog.routing_policies.map(policy => policy.policy_id));

  for (const endpoint of catalog.endpoints) {
    if (!connectorIds.has(endpoint.connector_id)) {
      errors.push(`endpoint ${endpoint.endpoint_id} references missing connector ${endpoint.connector_id}`);
    }
  }
  for (const connector of catalog.connectors) {
    for (const endpointId of connector.endpoint_ids) {
      if (!endpointIds.has(endpointId)) {
        errors.push(`connector ${connector.connector_id} references missing endpoint ${endpointId}`);
      }
    }
  }
  for (const policy of catalog.routing_policies) {
    if (!connectorIds.has(policy.connector_id)) {
      errors.push(`routing policy ${policy.policy_id} references missing connector ${policy.connector_id}`);
    }
  }
  for (const binding of catalog.chat_bindings) {
    if (!connectorIds.has(binding.connector_id)) {
      errors.push(`chat binding ${binding.binding_id} references missing connector ${binding.connector_id}`);
    }
    if (!endpointIds.has(binding.endpoint_id)) {
      errors.push(`chat binding ${binding.binding_id} references missing endpoint ${binding.endpoint_id}`);
    }
    if (!policyIds.has(binding.routing_policy_id)) {
      errors.push(`chat binding ${binding.binding_id} references missing policy ${binding.routing_policy_id}`);
    }
  }
  return errors;
}

export function resolveMessengerTargets(
  catalog: MessengerConnectorCatalog,
  input: { endpoint_id: string; chat_ref: string; chat_type?: MessengerChatType },
): MessengerRouteTarget[] {
  const binding = catalog.chat_bindings.find(item =>
    item.enabled
    && item.endpoint_id === input.endpoint_id
    && (item.chat_ref === input.chat_ref || item.chat_ref === "*")
  );
  if (!binding) return [];

  const policy = catalog.routing_policies.find(item => item.policy_id === binding.routing_policy_id);
  if (!policy) return [];

  const rule = policy.rules.find(item =>
    !item.match.chat_type
    || item.match.chat_type === "unknown"
    || item.match.chat_type === input.chat_type
  );
  return rule?.targets.length ? rule.targets : policy.default_targets;
}
