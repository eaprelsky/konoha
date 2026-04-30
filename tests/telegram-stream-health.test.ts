import { describe, expect, test } from "bun:test";
import {
  TELEGRAM_STREAM_THRESHOLDS,
  classifyTelegramGroupHealth,
} from "../src/telegram-stream-health";

describe("telegram stream health classification", () => {
  test("keeps thresholds aligned with healthcheck runbook values", () => {
    expect(TELEGRAM_STREAM_THRESHOLDS).toEqual({
      warn_lag: 100,
      warn_pending: 10,
      fail_pending: 100,
    });
  });

  test("classifies ok, warn, and fail by pending and lag", () => {
    expect(classifyTelegramGroupHealth({ pending: 0, lag: 0 })).toBe("ok");
    expect(classifyTelegramGroupHealth({ pending: 11, lag: 0 })).toBe("warn");
    expect(classifyTelegramGroupHealth({ pending: 0, lag: 101 })).toBe("warn");
    expect(classifyTelegramGroupHealth({ pending: 100, lag: 0 })).toBe("fail");
  });
});
