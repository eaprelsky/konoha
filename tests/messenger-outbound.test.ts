import { describe, expect, test } from "bun:test";
import {
  buildTelegramOutgoingEntry,
  resolveOutboundEndpoint,
  sendConnectorMessage,
} from "../src/messenger-outbound";
import { CURRENT_TELEGRAM_CONNECTOR_CATALOG } from "../src/messenger-connectors";
import { executeActionDirect } from "../src/action-executor";

describe("messenger outbound connector", () => {
  test("builds Telegram outgoing stream entries with connector metadata", () => {
    const entry = buildTelegramOutgoingEntry({
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "-4982206077",
      text: "hello",
      reply_to: "42",
      metadata: { case_id: "case-1" },
    });

    expect(entry).toMatchObject({
      provider: "telegram",
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "-4982206077",
      chat_id: "-4982206077",
      text: "hello",
      reply_to: "42",
      source_action: "connector.send_message",
    });
    expect(JSON.parse(entry.metadata)).toEqual({ case_id: "case-1" });
  });

  test("validates endpoint ownership and outbound adapter", () => {
    const endpoint = resolveOutboundEndpoint(
      CURRENT_TELEGRAM_CONNECTOR_CATALOG,
      "telegram-main",
      "telegram-user-sasuke",
    );
    expect(endpoint.outbound_adapter).toBe("telegram");

    expect(() => resolveOutboundEndpoint(
      CURRENT_TELEGRAM_CONNECTOR_CATALOG,
      "telegram-main",
      "missing-endpoint",
    )).toThrow("is not part of connector");
  });

  test("supports dry-run sends without publishing to Redis", async () => {
    const result = await sendConnectorMessage({
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "-4982206077",
      text: "dry-run outbound",
      dry_run: true,
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      stream: "telegram:outgoing",
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "-4982206077",
      adapter: "telegram",
    });
    expect(result.message_id).toBeUndefined();
    expect(result.entry.chat_id).toBe("-4982206077");
  });

  test("executes connector.send_message through Action Spine in dry-run mode", async () => {
    const result = await executeActionDirect("connector.send_message", {
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "-4982206077",
      text: "dry-run through action spine",
      dry_run: true,
    });

    expect(result?.status).toBe(200);
    expect(result?.data).toMatchObject({
      ok: true,
      dry_run: true,
      stream: "telegram:outgoing",
      endpoint_id: "telegram-user-sasuke",
    });
  });
});
