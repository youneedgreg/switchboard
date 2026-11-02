import { ProviderError } from "@switchboard/core";
import { describe, expect, it } from "vitest";
import { backoffMs, DEFAULT_RESILIENCE, retryDelayMs } from "../src/resilience/policy.js";
import { inMemoryRetryBudget } from "../src/resilience/retry-budget.js";

const serverError = () =>
  new ProviderError({ provider: "p", kind: "server", message: "boom", status: 503 });

describe("backoff", () => {
  const config = { backoffBaseMs: 100, backoffCapMs: 1_000 };

  it("doubles its ceiling per attempt, up to the cap", () => {
    const ceiling = (attempt: number) => backoffMs(attempt, config, () => 0.999_999);
    expect(ceiling(1)).toBe(99);
    expect(ceiling(2)).toBe(199);
    expect(ceiling(3)).toBe(399);
    expect(ceiling(10)).toBe(999);
  });

  it("uses full jitter, so it can pick anything down to zero", () => {
    expect(backoffMs(5, config, () => 0)).toBe(0);
  });
});

describe("retryDelayMs", () => {
  const rateLimited = (retryAfterMs: number) =>
    new ProviderError({ provider: "p", kind: "rate_limited", message: "429", retryAfterMs });

  it.each(["bad_request", "auth"] as const)("never retries %s", (kind) => {
    const error = new ProviderError({ provider: "p", kind, message: "no" });
    expect(retryDelayMs(error, 1, 60_000, DEFAULT_RESILIENCE)).toBeUndefined();
  });

  it("stops at maxAttempts", () => {
    const { maxAttempts } = DEFAULT_RESILIENCE;
    expect(retryDelayMs(serverError(), maxAttempts - 1, 60_000, DEFAULT_RESILIENCE)).toBeDefined();
    expect(retryDelayMs(serverError(), maxAttempts, 60_000, DEFAULT_RESILIENCE)).toBeUndefined();
  });

  it("waits at least as long as Retry-After asks", () => {
    const delay = retryDelayMs(rateLimited(1_500), 1, 60_000, DEFAULT_RESILIENCE, () => 0);
    expect(delay).toBe(1_500);
  });

  it("gives up rather than wait out a long Retry-After", () => {
    expect(retryDelayMs(rateLimited(30_000), 1, 60_000, DEFAULT_RESILIENCE)).toBeUndefined();
  });

  it("gives up when the wait would outlast the request", () => {
    expect(retryDelayMs(rateLimited(2_000), 1, 1_000, DEFAULT_RESILIENCE)).toBeUndefined();
  });
});

describe("retry budget", () => {
  const config = { ratio: 0.1, minPerSecond: 1, windowSeconds: 10 };

  it("allows the reserve when there is no traffic", async () => {
    const budget = inMemoryRetryBudget(config, () => 0);
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await budget.tryRetry("p"));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(results.at(-1)).toBe(false);
  });

  it("grows with traffic, at the configured ratio", async () => {
    const budget = inMemoryRetryBudget({ ...config, minPerSecond: 0 }, () => 0);
    for (let i = 0; i < 100; i++) await budget.recordRequest("p");
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await budget.tryRetry("p"));
    expect(results.filter(Boolean)).toHaveLength(10);
  });

  it("recovers once spent retries leave the window", async () => {
    let now = 0;
    const budget = inMemoryRetryBudget({ ...config, minPerSecond: 0.1 }, () => now);
    expect(await budget.tryRetry("p")).toBe(true);
    expect(await budget.tryRetry("p")).toBe(false);
    now = 10_000;
    expect(await budget.tryRetry("p")).toBe(true);
  });

  it("keeps providers separate", async () => {
    const budget = inMemoryRetryBudget({ ...config, minPerSecond: 0.1 }, () => 0);
    expect(await budget.tryRetry("a")).toBe(true);
    expect(await budget.tryRetry("a")).toBe(false);
    expect(await budget.tryRetry("b")).toBe(true);
  });
});
