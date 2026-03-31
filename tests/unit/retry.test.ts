import { describe, expect, test, vi } from "vitest";
import { computeDelay, retryWithBackoff } from "../../src/util/retry.js";

describe("computeDelay", () => {
  const baseOpts = { maxRetries: 5, baseDelay: 1000, maxDelay: 300_000, jitter: false };

  test("doubles delay each attempt without jitter", () => {
    expect(computeDelay(0, baseOpts)).toBe(1000);
    expect(computeDelay(1, baseOpts)).toBe(2000);
    expect(computeDelay(2, baseOpts)).toBe(4000);
    expect(computeDelay(3, baseOpts)).toBe(8000);
  });

  test("caps at maxDelay", () => {
    const opts = { ...baseOpts, maxDelay: 5000 };
    expect(computeDelay(10, opts)).toBe(5000);
  });

  test("adds jitter (0-30%) when enabled", () => {
    const opts = { ...baseOpts, jitter: true };
    const delays = Array.from({ length: 100 }, () => computeDelay(0, opts));
    const allInRange = delays.every((d) => d >= 1000 && d <= 1300);
    expect(allInRange).toBe(true);
    // Not all identical (jitter should vary)
    const unique = new Set(delays);
    expect(unique.size).toBeGreaterThan(1);
  });

  test("jitter does not exceed maxDelay", () => {
    const opts = { ...baseOpts, maxDelay: 1050, jitter: true };
    const delays = Array.from({ length: 100 }, () => computeDelay(0, opts));
    expect(delays.every((d) => d <= 1050)).toBe(true);
  });
});

describe("retryWithBackoff", () => {
  test("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { maxRetries: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries and succeeds on Nth attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValue("success");

    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelay: 1, jitter: false });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("throws last error when all retries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always-fail"));
    await expect(
      retryWithBackoff(fn, { maxRetries: 2, baseDelay: 1, jitter: false }),
    ).rejects.toThrow("always-fail");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test("uses default options when none provided", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await retryWithBackoff(fn);
    expect(result).toBe(42);
  });
});
