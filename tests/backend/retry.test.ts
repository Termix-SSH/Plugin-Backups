import { describe, expect, it } from "vitest";
import { retryState } from "../../src/backend/engine.js";

const job = { retries: 2, retryDelayMinutes: 10, retryCount: 0 };

describe("retry state", () => {
  it("waits and counts up while tries are left", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(retryState(job, "failed", now)).toEqual({
      retryCount: 1,
      retryAt: new Date(now + 600_000).toISOString(),
      willRetry: true,
    });
  });

  it("stops after the last try and resets on success", () => {
    expect(retryState({ ...job, retryCount: 2 }, "failed").willRetry).toBe(
      false,
    );
    expect(retryState({ ...job, retryCount: 1 }, "success")).toEqual({
      retryCount: 0,
      retryAt: null,
      willRetry: false,
    });
  });

  it("does nothing when retries are off", () => {
    expect(retryState({ ...job, retries: 0 }, "failed").willRetry).toBe(false);
  });
});
