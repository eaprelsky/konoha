import { describe, expect, test } from "bun:test";
import { buildMessengerConnectorHealth } from "../src/messenger-connector-health";
import { CURRENT_TELEGRAM_CONNECTOR_CATALOG } from "../src/messenger-connectors";
import type { TelegramStreamHealthSummary } from "../src/telegram-stream-health";

const telegramHealth: TelegramStreamHealthSummary = {
  thresholds: { warn_lag: 100, warn_pending: 10, fail_pending: 100 },
  checked_at: "2026-04-30T00:00:00.000Z",
  status: "ok",
  streams: [
    {
      stream: "telegram:bot:incoming",
      length: 1,
      status: "ok",
      groups: [{ group: "naruto", consumers: 1, pending: 0, lag: 0, status: "ok", detail: "consumers=1 pending=0 lag=0" }],
    },
    {
      stream: "telegram:incoming",
      length: 1,
      status: "ok",
      groups: [{ group: "sasuke", consumers: 1, pending: 0, lag: 0, status: "ok", detail: "consumers=1 pending=0 lag=0" }],
    },
    {
      stream: "telegram:reaction_updates",
      length: 1,
      status: "warn",
      groups: [{ group: "sasuke-reactions", consumers: 1, pending: 0, lag: 101, status: "warn", detail: "consumers=1 pending=0 lag=101" }],
    },
  ],
  dead_letters: [],
};

describe("messenger connector health", () => {
  test("projects Telegram stream health onto connector endpoints", () => {
    const health = buildMessengerConnectorHealth(CURRENT_TELEGRAM_CONNECTOR_CATALOG, telegramHealth);
    expect(health.connectors[0]).toMatchObject({
      connector_id: "telegram-main",
      provider: "telegram",
      status: "warn",
    });
    expect(health.connectors[0].endpoints).toEqual([
      {
        endpoint_id: "telegram-bot-naruto",
        connector_id: "telegram-main",
        provider: "telegram",
        status: "ok",
        streams: [{
          stream: "telegram:bot:incoming",
          group: "naruto",
          direction: "inbound",
          status: "ok",
          detail: "consumers=1 pending=0 lag=0",
        }],
      },
      {
        endpoint_id: "telegram-user-sasuke",
        connector_id: "telegram-main",
        provider: "telegram",
        status: "warn",
        streams: [
          {
            stream: "telegram:incoming",
            group: "sasuke",
            direction: "inbound",
            status: "ok",
            detail: "consumers=1 pending=0 lag=0",
          },
          {
            stream: "telegram:reaction_updates",
            group: "sasuke-reactions",
            direction: "reaction",
            status: "warn",
            detail: "consumers=1 pending=0 lag=101",
          },
        ],
      },
    ]);
  });

  test("fails an endpoint when its declared stream group is missing from health", () => {
    const health = buildMessengerConnectorHealth(CURRENT_TELEGRAM_CONNECTOR_CATALOG, {
      ...telegramHealth,
      streams: telegramHealth.streams.filter(stream => stream.stream !== "telegram:incoming"),
    });

    const sasuke = health.connectors[0].endpoints.find(endpoint => endpoint.endpoint_id === "telegram-user-sasuke");
    expect(sasuke?.status).toBe("fail");
    expect(sasuke?.streams[0]).toMatchObject({
      stream: "telegram:incoming",
      group: "sasuke",
      status: "fail",
    });
  });
});
