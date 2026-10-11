import { describe, expect, it } from "vitest";
import { ChaosParseError, failureStatus, parseChaos } from "../src/chaos.js";
import { generateTokens, mulberry32 } from "../src/text.js";

describe("parseChaos", () => {
  it("defaults to no chaos", () => {
    expect(parseChaos(null)).toEqual({ ttft_ms: 0, token_ms: 0 });
  });

  it("parses ; or , separated switches", () => {
    expect(parseChaos("ttft_ms=800; drop_after=12, status=429")).toMatchObject({
      ttft_ms: 800,
      drop_after: 12,
      status: 429,
    });
  });

  it("rejects unknown switches and bad values", () => {
    expect(() => parseChaos("explode=1")).toThrow(ChaosParseError);
    expect(() => parseChaos("status=200")).toThrow(ChaosParseError);
    expect(() => parseChaos("drop_after")).toThrow(ChaosParseError);
  });
});

describe("failureStatus", () => {
  it("always fails when only status is set", () => {
    expect(failureStatus(parseChaos("status=500"), Math.random)).toBe(500);
  });

  it("fails roughly fail_rate of the time with a seeded generator", () => {
    const chaos = parseChaos("fail_rate=0.3");
    const random = mulberry32(42);
    const failures = Array.from({ length: 10_000 }, () => failureStatus(chaos, random)).filter(
      (status) => status === 503,
    ).length;
    expect(failures / 10_000).toBeCloseTo(0.3, 1);
  });
});

describe("generateTokens", () => {
  it("is deterministic for the same prompt and seed", () => {
    const a = generateTokens("mock-lorem", "hello", { seed: 1 });
    const b = generateTokens("mock-lorem", "hello", { seed: 1 });
    const c = generateTokens("mock-lorem", "hello", { seed: 2 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(24);
  });

  it("echoes the prompt", () => {
    expect(generateTokens("mock-echo", "ping pong").join("")).toBe("ping pong");
    expect(generateTokens("mock-echo", "a b", { count: 3 }).join("")).toBe("a b a");
  });
});
