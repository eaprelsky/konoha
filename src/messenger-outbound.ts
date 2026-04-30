import { redis } from "./redis";
import {
  CURRENT_TELEGRAM_CONNECTOR_CATALOG,
  type MessengerConnectorCatalog,
  type MessengerEndpoint,
} from "./messenger-connectors";

export interface ConnectorSendMessageArgs {
  connector_id: string;
  endpoint_id: string;
  chat_ref: string;
  text: string;
  reply_to?: string;
  parse_mode?: string;
  dry_run?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ConnectorSendMessageResult {
  ok: true;
  dry_run: boolean;
  stream: string;
  message_id?: string;
  connector_id: string;
  endpoint_id: string;
  chat_ref: string;
  provider: string;
  adapter: string;
  entry: Record<string, string>;
}

export function resolveOutboundEndpoint(
  catalog: MessengerConnectorCatalog,
  connectorId: string,
  endpointId: string,
): MessengerEndpoint {
  const connector = catalog.connectors.find(item => item.connector_id === connectorId && item.enabled);
  if (!connector) throw new Error(`Connector not found or disabled: ${connectorId}`);
  if (!connector.endpoint_ids.includes(endpointId)) {
    throw new Error(`Endpoint ${endpointId} is not part of connector ${connectorId}`);
  }
  const endpoint = catalog.endpoints.find(item => item.endpoint_id === endpointId && item.connector_id === connectorId);
  if (!endpoint) throw new Error(`Endpoint not found: ${endpointId}`);
  if (endpoint.outbound_adapter !== "telegram") {
    throw new Error(`Endpoint ${endpointId} has no supported outbound adapter`);
  }
  return endpoint;
}

export function buildTelegramOutgoingEntry(args: ConnectorSendMessageArgs): Record<string, string> {
  const entry: Record<string, string> = {
    provider: "telegram",
    connector_id: args.connector_id,
    endpoint_id: args.endpoint_id,
    chat_ref: args.chat_ref,
    chat_id: args.chat_ref,
    text: args.text,
    source_action: "connector.send_message",
    timestamp: new Date().toISOString(),
  };
  if (args.reply_to) entry.reply_to = args.reply_to;
  if (args.parse_mode) entry.parse_mode = args.parse_mode;
  if (args.metadata && Object.keys(args.metadata).length > 0) {
    entry.metadata = JSON.stringify(args.metadata);
  }
  return entry;
}

export async function sendConnectorMessage(
  args: ConnectorSendMessageArgs,
  catalog: MessengerConnectorCatalog = CURRENT_TELEGRAM_CONNECTOR_CATALOG,
): Promise<ConnectorSendMessageResult> {
  if (!args.connector_id) throw new Error("connector_id is required");
  if (!args.endpoint_id) throw new Error("endpoint_id is required");
  if (!args.chat_ref) throw new Error("chat_ref is required");
  if (!args.text) throw new Error("text is required");

  const endpoint = resolveOutboundEndpoint(catalog, args.connector_id, args.endpoint_id);
  const stream = "telegram:outgoing";
  const entry = buildTelegramOutgoingEntry(args);

  if (args.dry_run) {
    return {
      ok: true,
      dry_run: true,
      stream,
      connector_id: args.connector_id,
      endpoint_id: args.endpoint_id,
      chat_ref: args.chat_ref,
      provider: "telegram",
      adapter: endpoint.outbound_adapter ?? "telegram",
      entry,
    };
  }

  const messageId = await redis.xadd(stream, "*", ...Object.entries(entry).flat());
  return {
    ok: true,
    dry_run: false,
    stream,
    message_id: messageId ?? undefined,
    connector_id: args.connector_id,
    endpoint_id: args.endpoint_id,
    chat_ref: args.chat_ref,
    provider: "telegram",
    adapter: endpoint.outbound_adapter ?? "telegram",
    entry,
  };
}
