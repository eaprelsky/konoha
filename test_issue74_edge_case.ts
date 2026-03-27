/**
 * Test edge case where konoha_send MCP tool could return undefined
 * This happens when:
 * 1. Server returns { error: null } without id field
 * 2. Server crashes and returns invalid JSON
 * 3. Network issue
 */

import { describe, test, expect } from "bun:test";

// Simulate the MCP tool behavior
function simulateMcpSend(result: any): string {
  if (result.error || !result.id) {
    return `Error sending message: ${result.error || JSON.stringify(result)}`;
  }
  return `Sent. ID: ${result.id}`;
}

describe("MCP konoha_send edge cases", () => {
  test("normal case: result has valid id", () => {
    const result = { id: "1234-567" };
    const output = simulateMcpSend(result);
    expect(output).toBe("Sent. ID: 1234-567");
    expect(output).not.toContain("undefined");
  });

  test("edge case: result has id=null", () => {
    const result = { id: null };
    const output = simulateMcpSend(result);
    // This would fail the check !result.id
    expect(output).toContain("Error");
    expect(output).not.toContain("Sent.");
  });

  test("edge case: result has id=undefined", () => {
    const result = { id: undefined };
    const output = simulateMcpSend(result);
    expect(output).toContain("Error");
    expect(output).not.toContain("Sent.");
  });

  test("edge case: result missing id field", () => {
    const result = { some_other_field: "value" };
    const output = simulateMcpSend(result);
    expect(output).toContain("Error");
    expect(output).not.toContain("undefined");
  });

  test("BUG: What if result is literally { id: undefined } and JSON stringifies it?", () => {
    // This is the actual bug case!
    const result: any = {};
    result.id = undefined;  // explicitly undefined
    const output = simulateMcpSend(result);
    console.log("Output:", output);
    // The check !result.id should catch this
    expect(output).toContain("Error");
  });
});
