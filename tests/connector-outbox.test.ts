import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  connectorSendMessageIdempotencyKey,
  connectorSendOutboxHooks,
  enqueueConnectorSendMessageEffect,
  handleConnectorSendMessageEffect,
  processRuntimeEffectOutboxOnceWithConnectorHandlers,
  type ConnectorSendMessageParams,
} from "../src/runtime/connector-outbox";
import {
  getRuntimeEffect,
  runtimeEffectIdFromIdempotencyKey,
} from "../src/runtime-effect-outbox";

const RUN = `connector-outbox-${Date.now()}`;
const originalSendConnectorMessage = connectorSendOutboxHooks.sendConnectorMessage;
const calls: ConnectorSendMessageParams[] = [];

function params(overrides: Partial<ConnectorSendMessageParams> = {}): ConnectorSendMessageParams {
  return {
    connector_id: "telegram-main",
    endpoint_id: "telegram-user-sasuke",
    chat_ref: "-4982206077",
    text: "runtime connector outbox dry-run",
    dry_run: true,
    metadata: { run: RUN },
    case_id: `${RUN}:case`,
    work_item_id: `${RUN}:work-item`,
    action_trace_id: `${RUN}:trace`,
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  connectorSendOutboxHooks.sendConnectorMessage = async (input: ConnectorSendMessageParams) => {
    calls.push(input);
    return {
      ok: true,
      dry_run: input.dry_run === true,
      stream: "telegram:outgoing",
      connector_id: input.connector_id,
      endpoint_id: input.endpoint_id,
      chat_ref: input.chat_ref,
      message_id: `${RUN}:message:${calls.length}`,
    };
  };
});

afterAll(() => {
  connectorSendOutboxHooks.sendConnectorMessage = originalSendConnectorMessage;
});

describe("connector send outbox", () => {
  test("enqueues connector.send_message effects with stable idempotency and links", async () => {
    const send = params({ text: "enqueue connector send" });
    const first = await enqueueConnectorSendMessageEffect(send, "2026-05-22T08:25:00.000Z");
    const duplicate = await enqueueConnectorSendMessageEffect(send, "2026-05-22T08:25:01.000Z");

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.effect_id).toBe(first.record.effect_id);
    expect(first.record).toMatchObject({
      kind: "connector.send_message",
      idempotency_key: connectorSendMessageIdempotencyKey(send),
      status: "pending",
      links: {
        connector_id: send.connector_id,
        case_id: send.case_id,
        work_item_id: send.work_item_id,
        action_trace_id: send.action_trace_id,
      },
      payload: {
        connector_id: send.connector_id,
        endpoint_id: send.endpoint_id,
        chat_ref: send.chat_ref,
        text: send.text,
        dry_run: true,
        metadata: { run: RUN },
      },
    });

    const processed = await processRuntimeEffectOutboxOnceWithConnectorHandlers({
      worker_id: "connector-worker",
      now: "2026-05-22T08:25:02.000Z",
      batch_size: 100,
    });
    expect(processed).toMatchObject({
      outcome: "succeeded",
      final_record: {
        effect_id: first.record.effect_id,
        status: "succeeded",
      },
    });
  });

  test("handler sends once and suppresses duplicate external sends after delivery", async () => {
    const send = params({ text: "dedupe connector send", action_trace_id: `${RUN}:dedupe` });
    const enqueued = await enqueueConnectorSendMessageEffect(send, "2026-05-22T08:26:00.000Z");

    const first = await handleConnectorSendMessageEffect(enqueued.record);
    const second = await handleConnectorSendMessageEffect(enqueued.record);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      chat_ref: "-4982206077",
      text: "dedupe connector send",
      dry_run: true,
      metadata: { run: RUN },
    });
    expect(first.receipt?.data).toMatchObject({
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      deduplicated: false,
      result: { ok: true, message_id: `${RUN}:message:1` },
    });
    expect(second.receipt?.data).toMatchObject({
      connector_id: "telegram-main",
      endpoint_id: "telegram-user-sasuke",
      deduplicated: true,
      result: { ok: true, message_id: `${RUN}:message:1` },
    });
  });

  test("worker retries connector failures and dead-letters at bounded attempts", async () => {
    connectorSendOutboxHooks.sendConnectorMessage = async () => {
      const error = new Error("connector unavailable") as Error & { code: string; retryable: boolean };
      error.code = "CONNECTOR_SEND_UNAVAILABLE";
      error.retryable = true;
      throw error;
    };
    const send = params({ text: "retry connector send", action_trace_id: `${RUN}:retry` });
    const enqueued = await enqueueConnectorSendMessageEffect(
      send,
      "2000-01-01T00:00:00.000Z",
      { max_attempts: 2, dead_letter_after_attempts: 2, backoff: "fixed", retry_delays_ms: [0] },
    );

    const retry = await processRuntimeEffectOutboxOnceWithConnectorHandlers({
      worker_id: "connector-worker",
      now: "2000-01-01T00:00:01.000Z",
      batch_size: 100,
    });
    expect(retry).toMatchObject({
      outcome: "retry",
      final_record: {
        effect_id: enqueued.record.effect_id,
        status: "retry",
        attempts: 1,
        error: { code: "CONNECTOR_SEND_UNAVAILABLE", retryable: true },
      },
    });

    const deadLetter = await processRuntimeEffectOutboxOnceWithConnectorHandlers({
      worker_id: "connector-worker",
      now: "2000-01-01T00:00:02.000Z",
      batch_size: 100,
    });
    expect(deadLetter).toMatchObject({
      outcome: "dead_letter",
      final_record: {
        effect_id: enqueued.record.effect_id,
        status: "dead_letter",
        attempts: 2,
        error: { code: "CONNECTOR_SEND_UNAVAILABLE", retryable: false },
      },
    });

    await expect(getRuntimeEffect(runtimeEffectIdFromIdempotencyKey(connectorSendMessageIdempotencyKey(send)))).resolves.toMatchObject({
      effect_id: enqueued.record.effect_id,
      status: "dead_letter",
    });
  });
});
