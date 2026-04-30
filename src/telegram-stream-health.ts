import { redis } from "./redis";

export type TelegramStreamStatus = "ok" | "warn" | "fail";

export interface TelegramConsumerGroupHealth {
  group: string;
  consumers: number;
  pending: number;
  lag: number;
  status: TelegramStreamStatus;
  detail: string;
}

export interface TelegramStreamHealth {
  stream: string;
  length: number;
  groups: TelegramConsumerGroupHealth[];
  status: TelegramStreamStatus;
}

export interface TelegramDeadLetterHealth {
  stream: string;
  length: number;
  status: TelegramStreamStatus;
}

export interface TelegramStreamHealthSummary {
  thresholds: {
    warn_lag: number;
    warn_pending: number;
    fail_pending: number;
  };
  streams: TelegramStreamHealth[];
  dead_letters: TelegramDeadLetterHealth[];
  status: TelegramStreamStatus;
  checked_at: string;
}

export const TELEGRAM_STREAM_GROUPS: Record<string, string[]> = {
  "telegram:incoming": ["sasuke"],
  "telegram:bot:incoming": ["naruto"],
  "telegram:reaction_updates": ["sasuke-reactions"],
  "telegram:needs_context": ["context-packer"],
  "telegram:log": ["event-bridge"],
  "telegram:vision_requests": ["vision-packer"],
  "telegram:outgoing": ["claude-agents"],
};

export const TELEGRAM_DEAD_LETTER_STREAMS = [
  "telegram:needs_context:dead_letter",
  "telegram:event_bridge:dead_letter",
  "telegram:vision_requests:dead_letter",
  "telegram:outgoing:dead_letter",
];

export const TELEGRAM_STREAM_THRESHOLDS = {
  warn_lag: 100,
  warn_pending: 10,
  fail_pending: 100,
};

export function classifyTelegramGroupHealth(input: { pending: number; lag: number }): TelegramStreamStatus {
  if (input.pending >= TELEGRAM_STREAM_THRESHOLDS.fail_pending) return "fail";
  if (input.pending > TELEGRAM_STREAM_THRESHOLDS.warn_pending || input.lag > TELEGRAM_STREAM_THRESHOLDS.warn_lag) return "warn";
  return "ok";
}

function worstStatus(statuses: TelegramStreamStatus[]): TelegramStreamStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

function groupArrayToObject(fields: unknown): Record<string, unknown> {
  if (!Array.isArray(fields)) return {};
  const out: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i += 2) {
    out[String(fields[i])] = fields[i + 1];
  }
  return out;
}

export async function getTelegramStreamHealth(): Promise<TelegramStreamHealthSummary> {
  const streams: TelegramStreamHealth[] = [];
  for (const [stream, expectedGroups] of Object.entries(TELEGRAM_STREAM_GROUPS)) {
    const length = Number(await redis.xlen(stream).catch(() => 0));
    const groupsRaw = await redis.xinfo("GROUPS", stream).catch(() => [] as unknown[]);
    const groupsByName = new Map<string, Record<string, unknown>>();
    for (const raw of groupsRaw as unknown[]) {
      const group = groupArrayToObject(raw);
      const name = String(group.name ?? "");
      if (name) groupsByName.set(name, group);
    }

    const groups = expectedGroups.map((groupName): TelegramConsumerGroupHealth => {
      const group = groupsByName.get(groupName);
      if (!group) {
        return {
          group: groupName,
          consumers: 0,
          pending: 0,
          lag: 0,
          status: "fail",
          detail: "consumer group missing",
        };
      }
      const pending = Number(group.pending ?? 0);
      const lag = Number(group.lag ?? 0);
      const consumers = Number(group.consumers ?? 0);
      const status = classifyTelegramGroupHealth({ pending, lag });
      return {
        group: groupName,
        consumers,
        pending,
        lag,
        status,
        detail: `consumers=${consumers} pending=${pending} lag=${lag}`,
      };
    });

    streams.push({
      stream,
      length,
      groups,
      status: worstStatus(groups.map(group => group.status)),
    });
  }

  const deadLetters = await Promise.all(TELEGRAM_DEAD_LETTER_STREAMS.map(async (stream) => {
    const length = Number(await redis.xlen(stream).catch(() => 0));
    return {
      stream,
      length,
      status: length > 0 ? "warn" as const : "ok" as const,
    };
  }));

  return {
    thresholds: TELEGRAM_STREAM_THRESHOLDS,
    streams,
    dead_letters: deadLetters,
    status: worstStatus([
      ...streams.map(stream => stream.status),
      ...deadLetters.map(stream => stream.status),
    ]),
    checked_at: new Date().toISOString(),
  };
}
