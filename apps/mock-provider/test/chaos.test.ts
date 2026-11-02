import { describe, expect, it } from "vitest";
import { ChaosParseError, chaosForAttempt, failureStatus, parseChaos } from "../src/chaos.js";
import { continueTokens, generateTokens, mulberry32 } from "../src/text.js";

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

describe("chaosForAttempt", () => {
  it("applies faults to every attempt by default", () => {
    const chaos = parseChaos("status=503");
    expect(chaosForAttempt(chaos, 9)).toBe(chaos);
  });

  it("drops faults after fail_attempts but keeps the response shape", () => {
    const chaos = parseChaos("drop_after=2; ttft_ms=50; tokens=5; seed=1; fail_attempts=1");
    expect(chaosForAttempt(chaos, 1)).toBe(chaos);
    expect(chaosForAttempt(chaos, 2)).toEqual({ ttft_ms: 0, token_ms: 0, tokens: 5, seed: 1 });
  });
});

describe("continueTokens", () => {
  const tokens = ["the", " quick", " brown", " fox"];

  it("finishes a partial answer", () => {
    expect(continueTokens(tokens, "the quick")).toEqual([" brown", " fox"]);
  });

  it("finishes one cut inside a token", () => {
    expect(continueTokens(tokens, "the qui").join("")).toBe("ck brown fox");
  });

  it("repeats the end of the partial when told to", () => {
    expect(continueTokens(tokens, "the quick", 5).join("")).toBe("quick brown fox");
    expect(continueTokens(tokens, "the quick", 99).join("")).toBe("the quick brown fox");
  });

  it("gives the whole answer if the partial is not the start of it", () => {
    expect(continueTokens(tokens, "something else").join("")).toBe("the quick brown fox");
  });

  it("gives nothing if the answer was already complete", () => {
    expect(continueTokens(tokens, "the quick brown fox")).toEqual([]);
  });
});
