import { getMessengerConnectorCatalog, type MessengerConnectorCatalog } from "./messenger-connectors";
import { getTelegramStreamHealth, type TelegramStreamHealthSummary, type TelegramStreamStatus } from "./telegram-stream-health";

export interface MessengerEndpointStreamHealth {
  stream: string;
  group: string;
  direction: string;
  status: TelegramStreamStatus;
  detail: string;
}

export interface MessengerEndpointHealth {
  endpoint_id: string;
  connector_id: string;
  provider: string;
  status: TelegramStreamStatus;
  streams: MessengerEndpointStreamHealth[];
}

export interface MessengerConnectorHealth {
  connector_id: string;
  provider: string;
  status: TelegramStreamStatus;
  endpoints: MessengerEndpointHealth[];
}

export interface MessengerConnectorHealthSummary {
  status: TelegramStreamStatus;
  checked_at: string;
  connectors: MessengerConnectorHealth[];
}

function worstStatus(statuses: TelegramStreamStatus[]): TelegramStreamStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

function streamStatus(
  telegramHealth: TelegramStreamHealthSummary,
  streamName: string,
  groupName: string,
): { status: TelegramStreamStatus; detail: string } {
  const stream = telegramHealth.streams.find(item => item.stream === streamName);
  if (!stream) return { status: "fail", detail: "stream missing from telegram health surface" };
  const group = stream.groups.find(item => item.group === groupName);
  if (!group) return { status: "fail", detail: "consumer group missing from telegram health surface" };
  return { status: group.status, detail: group.detail };
}

export function buildMessengerConnectorHealth(
  catalog: MessengerConnectorCatalog,
  telegramHealth: TelegramStreamHealthSummary,
): MessengerConnectorHealthSummary {
  const connectors = catalog.connectors
    .filter(connector => connector.enabled)
    .map((connector): MessengerConnectorHealth => {
      const endpoints = catalog.endpoints
        .filter(endpoint => endpoint.connector_id === connector.connector_id)
        .map((endpoint): MessengerEndpointHealth => {
          const streams = endpoint.inbound_streams.map((binding): MessengerEndpointStreamHealth => {
            if (connector.provider !== "telegram") {
              return {
                stream: binding.stream,
                group: binding.group,
                direction: binding.direction,
                status: "warn",
                detail: `provider ${connector.provider} has no stream health adapter yet`,
              };
            }
            const health = streamStatus(telegramHealth, binding.stream, binding.group);
            return {
              stream: binding.stream,
              group: binding.group,
              direction: binding.direction,
              status: health.status,
              detail: health.detail,
            };
          });
          return {
            endpoint_id: endpoint.endpoint_id,
            connector_id: endpoint.connector_id,
            provider: connector.provider,
            status: worstStatus(streams.map(stream => stream.status)),
            streams,
          };
        });
      return {
        connector_id: connector.connector_id,
        provider: connector.provider,
        status: worstStatus(endpoints.map(endpoint => endpoint.status)),
        endpoints,
      };
    });

  return {
    status: worstStatus(connectors.map(connector => connector.status)),
    checked_at: new Date().toISOString(),
    connectors,
  };
}

export async function getMessengerConnectorHealth(): Promise<MessengerConnectorHealthSummary> {
  return buildMessengerConnectorHealth(
    getMessengerConnectorCatalog(),
    await getTelegramStreamHealth(),
  );
}
