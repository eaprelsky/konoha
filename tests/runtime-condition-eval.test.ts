import { describe, expect, test } from "bun:test";
import { evalCondition } from "../src/runtime/cases/advancement";

describe("runtime condition evaluation", () => {
  test("supports safe AND/OR combinations for gateway guards", () => {
    expect(evalCondition(
      "payload.review_route === 'approved' && payload.closure_allowed === true",
      { review_route: "approved", closure_allowed: true },
    )).toBe(true);

    expect(evalCondition(
      "payload.review_route === 'approved' && payload.closure_allowed === true",
      { review_route: "approved", closure_allowed: false },
    )).toBe(false);

    expect(evalCondition(
      "payload.review_route === 'blocked' || payload.closure_allowed !== true",
      { review_route: "approved", closure_allowed: false },
    )).toBe(true);
  });
});
