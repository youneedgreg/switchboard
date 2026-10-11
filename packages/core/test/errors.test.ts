import { describe, expect, it } from "vitest";
import { kindForStatus, ProviderError, parseRetryAfter } from "../src/errors.js";

describe("kindForStatus", () => {
  it.each([
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [408, "timeout"],
    [401, "auth"],
    [403, "auth"],
    [400, "bad_request"],
    [422, "bad_request"],
  ] as const)("%i -> %s", (status, kind) => {
    expect(kindForStatus(status)).toBe(kind);
  });
});

describe("ProviderError", () => {
  it("marks transient failures retryable and client errors not", () => {
    const transient = ProviderError.fromStatus("mistral", 503, new Headers(), "");
    const permanent = ProviderError.fromStatus("mistral", 400, new Headers(), "bad");
    expect(transient.retryable).toBe(true);
    expect(permanent.retryable).toBe(false);
  });

  it("reads Retry-After", () => {
    const error = ProviderError.fromStatus("groq", 429, new Headers({ "retry-after": "2" }), "");
    expect(error.retryAfterMs).toBe(2000);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(parseRetryAfter("1.5", now)).toBe(1500);
    expect(parseRetryAfter("Sun, 11 Oct 2026 12:00:03 GMT", now)).toBe(3000);
    expect(parseRetryAfter("garbage", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
