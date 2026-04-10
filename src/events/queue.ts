/**
 * events/queue.ts — BullMQ delay queue for delay_after triggers.
 * Kept as a neutral module to avoid circular imports between subscriptions and delay-worker.
 */

import { Queue } from "bullmq";
import { REDIS_CONNECTION_OPTS } from "../redis";

export const DELAY_QUEUE_NAME = "event-manager-delay";

export const delayQueue = new Queue(DELAY_QUEUE_NAME, { connection: REDIS_CONNECTION_OPTS });
