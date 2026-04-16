import { beforeEach, describe, expect, mock, test } from "bun:test";
import { makeRoleDef, makeWorkflowDefinition } from "./factories";

type MockAgent = {
  id: string;
  name: string;
  capabilities?: string[];
};

const state = {
  agents: [] as MockAgent[],
  roleDef: null as ReturnType<typeof makeRoleDef> | null,
  personByRole: null as { name: string; tg_id?: number; tg_username?: string } | null,
  personById: null as { name: string; tg_id?: number; tg_username?: string } | null,
  instructionText: "Review request",
  systemRole: false,
  agentLoads: {} as Record<string, number>,
  rrCounter: 0,
  sentMessages: [] as Array<{ from: string; to: string; type: string; text: string }>,
  telegramExecs: [] as Array<{ cmd: string; args: string[] }>,
  systemExecutions: [] as Array<Record<string, unknown>>,
};

mock.module("../src/redis", () => ({
  redis: {
    async scard(key: string) {
      const agentId = key.split(":").pop() ?? "";
      return state.agentLoads[agentId] ?? 0;
    },
    async incr() {
      state.rrCounter += 1;
      return state.rrCounter;
    },
  },
  async listAgents(onlineOnly?: boolean) {
    return onlineOnly ? state.agents : state.agents;
  },
  async sendMessage(message: { from: string; to: string; type: string; text: string }) {
    state.sentMessages.push(message);
    return "mock-stream-id";
  },
}));

mock.module("../src/document-instructions", () => ({
  async loadInstructionText(_docIds: string[], fallback = "") {
    return state.instructionText || fallback;
  },
}));

mock.module("../src/people-directory", () => ({
  async findPersonByRole() {
    return state.personByRole;
  },
  async findPersonById() {
    return state.personById;
  },
}));

mock.module("../src/system-agent", () => ({
  isSystemRole(role: string) {
    return state.systemRole && role === "System";
  },
  async executeSystemFunction(params: Record<string, unknown>) {
    state.systemExecutions.push(params);
  },
}));

mock.module("../src/runtime/roles", () => ({
  async loadRole() {
    return state.roleDef;
  },
}));

mock.module("child_process", () => ({
  execFile(
    cmd: string,
    args: string[],
    callback: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) {
    state.telegramExecs.push({ cmd, args });
    callback(null, "", "");
  },
}));

const { dispatchWorkItem } = await import("../src/dispatcher");

function resetState() {
  state.agents = [];
  state.roleDef = null;
  state.personByRole = null;
  state.personById = null;
  state.instructionText = "Review request";
  state.systemRole = false;
  state.agentLoads = {};
  state.rrCounter = 0;
  state.sentMessages = [];
  state.telegramExecs = [];
  state.systemExecutions = [];
}

beforeEach(resetState);

describe("dispatcher coverage", () => {
  test("dispatches to the least loaded agent for load-balancing roles", async () => {
    state.agents = [
      { id: "naruto", name: "Naruto" },
      { id: "sasuke", name: "Sasuke" },
    ];
    state.agentLoads = { naruto: 3, sasuke: 1 };
    state.roleDef = makeRoleDef({
      role_id: "operator",
      assignees: ["naruto", "sasuke"],
      strategy: "load-balancing",
    });

    await dispatchWorkItem({
      role: "operator",
      label: "Review request",
      work_item_id: "wi-load",
      case_id: "case-1",
      process_id: "proc-1",
      element_id: "fn_1",
      docIds: [],
    });

    expect(state.sentMessages).toHaveLength(1);
    expect(state.sentMessages[0].to).toBe("sasuke");
    expect(state.sentMessages[0].text).toContain("Роль: operator (role-m2m:load-balancing)");
    expect(state.sentMessages[0].text).toContain("Функция: Review request");
  });

  test("rotates assignees for round-robin roles", async () => {
    state.agents = [
      { id: "naruto", name: "Naruto" },
      { id: "sasuke", name: "Sasuke" },
    ];
    state.roleDef = makeRoleDef({
      role_id: "operator",
      assignees: ["naruto", "sasuke"],
      strategy: "round-robin",
    });

    await dispatchWorkItem({
      role: "operator",
      label: "First task",
      work_item_id: "wi-1",
      case_id: "case-1",
      process_id: "proc-1",
      element_id: "fn_1",
      docIds: [],
    });
    await dispatchWorkItem({
      role: "operator",
      label: "Second task",
      work_item_id: "wi-2",
      case_id: "case-1",
      process_id: "proc-1",
      element_id: "fn_1",
      docIds: [],
    });

    expect(state.sentMessages).toHaveLength(2);
    expect(state.sentMessages[0].to).toBe("naruto");
    expect(state.sentMessages[1].to).toBe("sasuke");
  });

  test("broadcasts to all role assignees", async () => {
    state.agents = [
      { id: "naruto", name: "Naruto" },
      { id: "sasuke", name: "Sasuke" },
    ];
    state.roleDef = makeRoleDef({
      role_id: "operator",
      assignees: ["naruto", "sasuke"],
      strategy: "broadcast",
    });

    await dispatchWorkItem({
      role: "operator",
      label: "Broadcast task",
      work_item_id: "wi-broadcast",
      case_id: "case-1",
      process_id: "proc-1",
      element_id: "fn_1",
      docIds: [],
    });

    expect(state.sentMessages).toHaveLength(2);
    expect(state.sentMessages.map((item) => item.to)).toEqual(["naruto", "sasuke"]);
    expect(state.sentMessages.every((item) => item.text.includes("Rоль") === false)).toBe(true);
    expect(state.sentMessages.every((item) => item.text.includes("broadcast"))).toBe(true);
  });

  test("falls back to capability-matched agent and builds process context with payload", async () => {
    state.agents = [
      { id: "kakashi", name: "Kakashi", capabilities: ["QA"] },
      { id: "guy", name: "Guy", capabilities: ["QA"] },
    ];
    state.agentLoads = { kakashi: 4, guy: 0 };
    state.instructionText = "Read the checklist before reviewing.";

    await dispatchWorkItem({
      role: "QA",
      label: "Review request",
      work_item_id: "wi-direct",
      case_id: "case-qa",
      process_id: "proc-qa",
      element_id: "fn_1",
      docIds: ["doc-1"],
      def: makeWorkflowDefinition({
        id: "proc-qa",
        name: "QA Flow",
        elements: [
          { id: "event_start", type: "event", label: "Bug reported" },
          { id: "fn_1", type: "function", label: "Review request", role: "QA", systems: [{ connector: "tracker", operation: "triage" }], intent: "Validate severity" },
          { id: "event_end", type: "event", label: "Bug triaged" },
        ],
        flow: [["event_start", "fn_1"], ["fn_1", "event_end"]],
      }),
      payload: { issue: 537, severity: "medium" },
    });

    expect(state.sentMessages).toHaveLength(1);
    expect(state.sentMessages[0].to).toBe("guy");
    expect(state.sentMessages[0].text).toContain("Процесс: QA Flow (proc-qa)");
    expect(state.sentMessages[0].text).toContain("→ СЕЙЧАС: Review request [function]");
    expect(state.sentMessages[0].text).toContain("Системы: tracker (triage)");
    expect(state.sentMessages[0].text).toContain("Цель: Validate severity");
    expect(state.sentMessages[0].text).toContain("\"issue\": 537");
    expect(state.sentMessages[0].text).toContain("Инструкция:\nRead the checklist before reviewing.");
    expect(state.sentMessages[0].text).toContain("Роль: QA (direct-match)");
  });

  test("routes to a person via telegram when role resolves to a custom person", async () => {
    state.personByRole = { name: "QA Human", tg_id: 4242, tg_username: "qa-human" };
    state.instructionText = "Call the customer back.";

    await dispatchWorkItem({
      role: "Support",
      label: "Contact customer",
      work_item_id: "wi-person",
      case_id: "case-support",
      process_id: "proc-support",
      element_id: "fn_support",
      docIds: ["doc-1"],
    });

    expect(state.sentMessages).toHaveLength(0);
    expect(state.telegramExecs).toHaveLength(1);
    expect(state.telegramExecs[0].cmd).toBe("python3");
    expect(state.telegramExecs[0].args[0]).toContain("naruto-tg-send.py");
    expect(state.telegramExecs[0].args[1]).toBe("4242");
    expect(state.telegramExecs[0].args[2]).toContain("Новая задача: Contact customer");
    expect(state.telegramExecs[0].args[2]).toContain("Call the customer back.");
  });

  test("delegates system roles to system-agent execution", async () => {
    state.systemRole = true;

    await dispatchWorkItem({
      role: "System",
      label: "Подождать 5 минут",
      work_item_id: "wi-system",
      case_id: "case-system",
      process_id: "proc-system",
      element_id: "fn_wait",
      docIds: [],
    });

    expect(state.systemExecutions).toHaveLength(1);
    expect(state.systemExecutions[0].work_item_id).toBe("wi-system");
    expect(state.sentMessages).toHaveLength(0);
    expect(state.telegramExecs).toHaveLength(0);
  });
});
