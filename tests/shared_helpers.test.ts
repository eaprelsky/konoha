import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { loadInstructionText } from "../src/document-instructions";
import { findPersonById, findPersonByRole } from "../src/people-directory";

const redis = new Redis({ host: "127.0.0.1", port: 6379, db: parseInt(process.env.REDIS_DB ?? "0", 10) });
const DOC_ID = `doc-test-${Date.now()}`;
const PERSON_ID = `person-test-${Date.now()}`;

beforeAll(async () => {
  await redis.del(`doc:${DOC_ID}`);
  await redis.hdel("people:custom", PERSON_ID);
});

afterAll(async () => {
  await redis.del(`doc:${DOC_ID}`);
  await redis.hdel("people:custom", PERSON_ID);
  redis.disconnect();
});

describe("shared helper coverage", () => {
  test("loadInstructionText returns fallback when no docs found", async () => {
    const text = await loadInstructionText([], "Fallback Label");
    expect(text).toBe("Fallback Label");
  });

  test("loadInstructionText loads and formats attached docs", async () => {
    await redis.set(`doc:${DOC_ID}`, JSON.stringify({ name: "Guide", content: "Step 1\nStep 2" }));
    const text = await loadInstructionText([DOC_ID], "Fallback");
    expect(text).toContain("[Guide]");
    expect(text).toContain("Step 1");
  });

  test("people-directory finds custom person by role and username", async () => {
    await redis.hset("people:custom", PERSON_ID, JSON.stringify({
      id: PERSON_ID,
      name: "Test User",
      tg_id: 123,
      tg_username: "test-user",
      position: "QA",
    }));

    const byRole = await findPersonByRole("QA");
    expect(byRole?.name).toBe("Test User");

    const byId = await findPersonById("@test-user");
    expect(byId?.tg_id).toBe(123);
  });
});
