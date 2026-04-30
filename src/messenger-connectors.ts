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

export interface MessengerRoutingResolution {
  targets: MessengerRouteTarget[];
  workflow_ids: string[] | null;
  binding_id?: string;
  policy_id?: string;
  rule_id?: string;
}

export interface MessengerRoutingRule {
  rule_id: string;
  description: string;
  match: {
    endpoint_id?: string;
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
      default_targets: [],
      enabled_workflow_ids: ["telegram-lead-intake"],
      rules: [
        {
          rule_id: "bot-owner-escalation",
          description: "Bot endpoint can start workflow triggers or delegate operator replies to Naruto.",
          match: { endpoint_id: "telegram-bot-naruto", chat_type: "direct" },
          targets: [
            { target_type: "workflow", target_id: "telegram-lead-intake" },
            { target_type: "agent", target_id: "naruto" },
          ],
          enabled_workflow_ids: ["telegram-lead-intake"],
        },
        {
          rule_id: "bot-compat-routing",
          description: "Bot endpoint falls back to the bot compatibility runtime.",
          match: { endpoint_id: "telegram-bot-naruto" },
          targets: [{ target_type: "agent", target_id: "naruto" }],
        },
        {
          rule_id: "user-account-routing",
          description: "User-account endpoint routes direct/group messages through Sasuke compatibility runtime.",
          match: { endpoint_id: "telegram-user-sasuke" },
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
      binding_id: "telegram-user-comind-leads",
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "-4982206077",
      chat_type: "group",
      routing_policy_id: "telegram-compat-routing",
      enabled_workflow_ids: ["lead-qualification"],
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
  return resolveMessengerRouting(catalog, input)?.targets ?? [];
}

export function resolveMessengerWorkflowIds(
  catalog: MessengerConnectorCatalog,
  input: { endpoint_id: string; chat_ref: string; chat_type?: MessengerChatType },
): string[] | null {
  return resolveMessengerRouting(catalog, input)?.workflow_ids ?? null;
}

export function resolveMessengerRouting(
  catalog: MessengerConnectorCatalog,
  input: { endpoint_id: string; chat_ref: string; chat_type?: MessengerChatType },
): MessengerRoutingResolution | null {
  const binding = findChatBinding(catalog, input);
  if (!binding) return null;

  const policy = catalog.routing_policies.find(item => item.policy_id === binding.routing_policy_id);
  if (!policy) return null;

  const rule = policy.rules.find(item => ruleMatches(item, input));
  const targets = rule?.targets.length ? rule.targets : policy.default_targets;
  return {
    targets,
    workflow_ids: explicitWorkflowIds(binding.enabled_workflow_ids, rule, targets),
    binding_id: binding.binding_id,
    policy_id: policy.policy_id,
    rule_id: rule?.rule_id,
  };
}

function findChatBinding(
  catalog: MessengerConnectorCatalog,
  input: { endpoint_id: string; chat_ref: string; chat_type?: MessengerChatType },
): MessengerChatBinding | undefined {
  const candidates = catalog.chat_bindings.filter(item =>
    item.enabled
    && item.endpoint_id === input.endpoint_id
    && (item.chat_ref === input.chat_ref || item.chat_ref === "*")
    && (!item.chat_type || item.chat_type === "unknown" || !input.chat_type || item.chat_type === input.chat_type)
  );
  return candidates.sort(bindingSpecificity)[0];
}

function bindingSpecificity(a: MessengerChatBinding, b: MessengerChatBinding): number {
  const score = (item: MessengerChatBinding) =>
    (item.chat_ref === "*" ? 0 : 2) + (item.chat_type === "unknown" ? 0 : 1);
  return score(b) - score(a);
}

function explicitWorkflowIds(
  bindingWorkflowIds: string[],
  rule: MessengerRoutingRule | undefined,
  targets: MessengerRouteTarget[],
): string[] | null {
  const ids = [
    ...bindingWorkflowIds,
    ...(rule?.enabled_workflow_ids ?? []),
    ...targets.filter(target => target.target_type === "workflow").map(target => target.target_id),
  ];
  const unique = [...new Set(ids.filter(Boolean))];
  return unique.length ? unique : null;
}

function ruleMatches(
  rule: MessengerRoutingRule,
  input: { endpoint_id: string; chat_ref: string; chat_type?: MessengerChatType },
): boolean {
  if (rule.match.endpoint_id && rule.match.endpoint_id !== input.endpoint_id) return false;
  if (rule.match.chat_id && rule.match.chat_id !== input.chat_ref) return false;
  if (rule.match.chat_type && rule.match.chat_type !== input.chat_type) return false;
  return true;
}
