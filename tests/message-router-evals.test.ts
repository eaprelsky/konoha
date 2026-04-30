import { describe, expect, test } from "bun:test";
import {
  MESSAGE_ROUTER_FIXTURES,
  MESSAGE_ROUTING_LABELS,
  expectedFixtureClassifier,
  runMessageRouterEval,
  scoreMessageRouterPrediction,
} from "../src/message-router-evals";

describe("message router eval harness", () => {
  test("defines the routing label set needed before production classifier work", () => {
    expect(MESSAGE_ROUTING_LABELS).toEqual([
      "ignore",
      "human_notify",
      "sales_workflow",
      "ops_task",
      "knowledge_intake",
      "dev_workflow",
      "unknown_escalate",
    ]);
  });

  test("fixtures include long-context and ambiguous cases without real chat data", () => {
    const longContext = MESSAGE_ROUTER_FIXTURES.find(fixture => fixture.id === "sales-long-context");
    const ambiguous = MESSAGE_ROUTER_FIXTURES.find(fixture => fixture.id === "ambiguous-escalate");

    expect(longContext?.history.length).toBeGreaterThan(20);
    expect(longContext?.expected).toMatchObject({
      label: "sales_workflow",
      required_context_refs: ["m05", "m18", "m24"],
    });
    expect(ambiguous?.expected.label).toBe("unknown_escalate");
  });

  test("scores missing required context references deterministically", () => {
    const fixture = MESSAGE_ROUTER_FIXTURES.find(item => item.id === "sales-long-context");
    if (!fixture) throw new Error("missing sales-long-context fixture");

    const score = scoreMessageRouterPrediction(fixture, {
      label: "sales_workflow",
      context_refs: ["m18"],
    });

    expect(score.passed).toBe(false);
    expect(score.label_match).toBe(true);
    expect(score.missing_context_refs).toEqual(["m05", "m24"]);
  });

  test("runs offline evals through a pluggable classifier interface", async () => {
    const results = await runMessageRouterEval(MESSAGE_ROUTER_FIXTURES, expectedFixtureClassifier);

    expect(results).toHaveLength(MESSAGE_ROUTER_FIXTURES.length);
    expect(results.every(result => result.score.passed)).toBe(true);
    expect(results.map(result => result.fixture_id)).toContain("ops-incident");
    expect(results.map(result => result.fixture_id)).toContain("dev-request");
  });
});
