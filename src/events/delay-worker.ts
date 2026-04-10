/**
 * events/delay-worker.ts — BullMQ Worker for delay_after triggers.
 */

import { Worker } from "bullmq";
import { REDIS_CONNECTION_OPTS, redis } from "../redis";
import { createLogger } from "../logger";
import type { Subscription } from "./types";
import type { DelayAfterTrigger } from "./types";
import { DELAY_QUEUE_NAME } from "./queue";
import { publishEventFired, SUBSCRIPTIONS_KEY } from "./subscriptions";

const log = createLogger("event-manager");

let delayWorker: Worker | null = null;

export function startDelayWorker(): void {
  if (delayWorker) return;

  delayWorker = new Worker(
    DELAY_QUEUE_NAME,
    async (job) => {
      const { subscription_id } = job.data as { subscription_id: string };
      const raw = await redis.hget(SUBSCRIPTIONS_KEY, subscription_id);
      if (!raw) return; // already gone
      const sub: Subscription = JSON.parse(raw);
      if (sub.status !== "active") return; // already cancelled

      const trigger = sub.trigger as DelayAfterTrigger;
      await publishEventFired(sub, {
        duration: trigger.duration,
        ref_event: trigger.ref_event ?? null,
      });

      // delay_after fires once — auto-cancel
      sub.status = "cancelled";
      await redis.hset(SUBSCRIPTIONS_KEY, sub.id, JSON.stringify(sub));
      log.info(`[event-manager] delay_after fired and cancelled sub=${sub.id}`);
    },
    { connection: REDIS_CONNECTION_OPTS },
  );

  delayWorker.on("failed", (job, err) => {
    log.error(`[event-manager] delay job failed job=${job?.id}: ${err.message}`);
  });

  log.info("[event-manager] delay_after worker started");
}
