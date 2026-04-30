export type MessageRoutingLabel =
  | "ignore"
  | "human_notify"
  | "sales_workflow"
  | "ops_task"
  | "knowledge_intake"
  | "dev_workflow"
  | "unknown_escalate";

export const MESSAGE_ROUTING_LABELS: MessageRoutingLabel[] = [
  "ignore",
  "human_notify",
  "sales_workflow",
  "ops_task",
  "knowledge_intake",
  "dev_workflow",
  "unknown_escalate",
];

export interface TelegramLikeMessage {
  ref: string;
  chat_id: string;
  chat_title: string;
  sender: string;
  text: string;
  timestamp: string;
}

export interface MessageRouterExpected {
  label: MessageRoutingLabel;
  required_context_refs: string[];
}

export interface MessageRouterFixture {
  id: string;
  description: string;
  history: TelegramLikeMessage[];
  expected: MessageRouterExpected;
}

export interface MessageRouterPrediction {
  label: MessageRoutingLabel;
  context_refs: string[];
  rationale?: string;
}

export interface MessageRouterScore {
  passed: boolean;
  label_match: boolean;
  missing_context_refs: string[];
  extra_context_refs: string[];
}

export type MessageRouterClassifier = (
  fixture: MessageRouterFixture,
) => MessageRouterPrediction | Promise<MessageRouterPrediction>;

export function scoreMessageRouterPrediction(
  fixture: MessageRouterFixture,
  prediction: MessageRouterPrediction,
): MessageRouterScore {
  const expectedRefs = new Set(fixture.expected.required_context_refs);
  const predictedRefs = new Set(prediction.context_refs);
  const missing = [...expectedRefs].filter(ref => !predictedRefs.has(ref));
  const extra = [...predictedRefs].filter(ref => !expectedRefs.has(ref));
  const labelMatch = prediction.label === fixture.expected.label;
  return {
    passed: labelMatch && missing.length === 0,
    label_match: labelMatch,
    missing_context_refs: missing,
    extra_context_refs: extra,
  };
}

export async function runMessageRouterEval(
  fixtures: MessageRouterFixture[],
  classifier: MessageRouterClassifier,
): Promise<Array<{ fixture_id: string; prediction: MessageRouterPrediction; score: MessageRouterScore }>> {
  const results = [];
  for (const fixture of fixtures) {
    const prediction = await classifier(fixture);
    results.push({
      fixture_id: fixture.id,
      prediction,
      score: scoreMessageRouterPrediction(fixture, prediction),
    });
  }
  return results;
}

export const expectedFixtureClassifier: MessageRouterClassifier = (fixture) => ({
  label: fixture.expected.label,
  context_refs: fixture.expected.required_context_refs,
  rationale: "Fixture oracle for deterministic harness tests.",
});

const baseTs = "2026-04-30T08:";

function msg(ref: string, chat: string, sender: string, text: string, minute: number): TelegramLikeMessage {
  return {
    ref,
    chat_id: chat.includes("sales") ? "-100-sales" : "-100-ops",
    chat_title: chat,
    sender,
    text,
    timestamp: `${baseTs}${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

function longLeadHistory(): TelegramLikeMessage[] {
  const filler = Array.from({ length: 22 }, (_, index) => {
    const n = index + 1;
    return msg(`m${String(n).padStart(2, "0")}`, "coMind Лиды", n % 2 ? "Client" : "Sales", `Context message ${n}`, n);
  });
  filler[4] = msg("m05", "coMind Лиды", "Client", "We discussed replacing manual request intake last month.", 5);
  filler[17] = msg("m18", "coMind Лиды", "Client", "We need an AI assistant to classify inbound sales requests.", 18);
  filler.push(msg("m23", "coMind Лиды", "Sales", "Can we schedule discovery and estimate MVP scope?", 23));
  filler.push(msg("m24", "coMind Лиды", "Client", "Yes, please send next steps and pricing ranges.", 24));
  return filler;
}

export const MESSAGE_ROUTER_FIXTURES: MessageRouterFixture[] = [
  {
    id: "ignore-thanks",
    description: "Short acknowledgement that should not wake Sasuke.",
    history: [msg("m01", "random chat", "User", "Спасибо, принято.", 1)],
    expected: { label: "ignore", required_context_refs: ["m01"] },
  },
  {
    id: "human-notify-owner",
    description: "Human attention requested explicitly.",
    history: [msg("m01", "ops chat", "Owner", "Позовите Егора, нужно решение сегодня.", 1)],
    expected: { label: "human_notify", required_context_refs: ["m01"] },
  },
  {
    id: "sales-long-context",
    description: "Long history where the lead signal depends on late and earlier context.",
    history: longLeadHistory(),
    expected: { label: "sales_workflow", required_context_refs: ["m05", "m18", "m24"] },
  },
  {
    id: "ops-incident",
    description: "Operational incident should become an ops task.",
    history: [
      msg("m01", "ops chat", "Akamaru", "telegram-bus lag is growing", 1),
      msg("m02", "ops chat", "Owner", "Проверьте healthcheck и восстановите сервис.", 2),
    ],
    expected: { label: "ops_task", required_context_refs: ["m01", "m02"] },
  },
  {
    id: "knowledge-source",
    description: "User shares durable knowledge source for curation.",
    history: [msg("m01", "research chat", "User", "Сохраните этот разбор в базу знаний: https://example.invalid/article", 1)],
    expected: { label: "knowledge_intake", required_context_refs: ["m01"] },
  },
  {
    id: "dev-request",
    description: "Concrete engineering request should route to dev workflow.",
    history: [msg("m01", "dev chat", "PM", "Создайте issue: добавить parity guard для MCP tools.", 1)],
    expected: { label: "dev_workflow", required_context_refs: ["m01"] },
  },
  {
    id: "ambiguous-escalate",
    description: "Ambiguous request with insufficient routing confidence should escalate.",
    history: [
      msg("m01", "mixed chat", "User", "Это надо куда-то отправить.", 1),
      msg("m02", "mixed chat", "User", "Там и продажи, и поддержка, и база знаний.", 2),
    ],
    expected: { label: "unknown_escalate", required_context_refs: ["m01", "m02"] },
  },
];
