import { ProviderError, type StreamEvent } from "@switchboard/core";
import { describe, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderCall } from "../src/providers/types.js";
import { runAttempts } from "../src/resilience/attempts.js";
import { inMemoryRetryBudget } from "../src/resilience/retry-budget.js";
import { chatRequest, FAST_RESILIENCE, sseData, testGateway } from "./helpers.js";

const serverError = (provider = "script") =>
  new ProviderError({ provider, kind: "server", message: "boom", status: 503 });

const generous = () => inMemoryRetryBudget({ ratio: 1, minPerSecond: 1_000, windowSeconds: 10 });

/** An adapter that runs a different script for each attempt and counts them. */
function scripted(
  ...attempts: Array<(call: ProviderCall) => AsyncGenerator<StreamEvent>>
): ProviderAdapter & { calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  return {
    name: "script",
    models: ["s"],
    calls,
    stream(call) {
      calls.push(call);
      const attempt = attempts[calls.length - 1] ?? attempts.at(-1);
      if (!attempt) throw new Error("no script");
      return attempt(call);
    },
  };
}

async function* healthy(): AsyncGenerator<StreamEvent> {
  yield { type: "start", upstreamId: "u", model: "s" };
  yield { type: "delta", content: "ok" };
  yield { type: "finish", reason: "stop" };
}

async function* failsAtOnce(): AsyncGenerator<StreamEvent> {
  yield* [];
  throw serverError();
}

async function* failsAfterStart(): AsyncGenerator<StreamEvent> {
  yield { type: "start", upstreamId: "u", model: "s" };
  throw serverError();
}

async function* failsMidway(): AsyncGenerator<StreamEvent> {
  yield { type: "start", upstreamId: "u", model: "s" };
  yield { type: "delta", content: "par" };
  throw serverError();
}

/** Waits forever, but honours the abort the way a real fetch does. */
async function* hangs({ signal }: ProviderCall): AsyncGenerator<StreamEvent> {
  await new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const run = (
  adapter: ProviderAdapter,
  overrides: Partial<Parameters<typeof runAttempts>[0]> = {},
) =>
  runAttempts({
    adapter,
    upstreamModel: "s",
    body: { model: "script/s", messages: [{ role: "user", content: "x" }] },
    headers: new Headers(),
    signal: new AbortController().signal,
    commitOn: "first-token",
    config: FAST_RESILIENCE,
    budget: generous(),
    ...overrides,
  });

async function drain(events: AsyncIterator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) return out;
    out.push(value);
  }
}

describe("the attempt loop", () => {
  it("retries a failure before the first event", async () => {
    const adapter = scripted(failsAtOnce, healthy);
    const events = await drain(await run(adapter));
    expect(adapter.calls.map((call) => call.attempt)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "finish"]);
  });

  it("retries a failure after start but before the first token", async () => {
    const adapter = scripted(failsAfterStart, healthy);
    const events = await drain(await run(adapter));
    expect(adapter.calls).toHaveLength(2);
    // The failed attempt's start is discarded: exactly one role chunk reaches the client.
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
  });

  it("stops after maxAttempts and throws the last error", async () => {
    const adapter = scripted(failsAtOnce);
    await expect(run(adapter)).rejects.toBeInstanceOf(ProviderError);
    expect(adapter.calls).toHaveLength(FAST_RESILIENCE.maxAttempts);
  });

  it("never retries a non-retryable failure", async () => {
    const adapter = scripted(async function* () {
      yield* [];
      throw new ProviderError({ provider: "script", kind: "bad_request", message: "no" });
    });
    await expect(run(adapter)).rejects.toMatchObject({ kind: "bad_request" });
    expect(adapter.calls).toHaveLength(1);
  });

  it("stops retrying when the budget is spent", async () => {
    const adapter = scripted(failsAtOnce);
    const budget = inMemoryRetryBudget({ ratio: 0, minPerSecond: 0, windowSeconds: 10 });
    await expect(run(adapter, { budget })).rejects.toBeInstanceOf(ProviderError);
    expect(adapter.calls).toHaveLength(1);
  });

  it("does not retry after the first token when streaming", async () => {
    const adapter = scripted(failsMidway, healthy);
    const events = await run(adapter);
    await expect(drain(events)).rejects.toBeInstanceOf(ProviderError);
    expect(adapter.calls).toHaveLength(1);
  });

  it("retries a failure anywhere in a non-streaming attempt", async () => {
    const adapter = scripted(failsMidway, healthy);
    const events = await drain(await run(adapter, { commitOn: "complete" }));
    expect(adapter.calls).toHaveLength(2);
    expect(events).toContainEqual({ type: "delta", content: "ok" });
    expect(events).not.toContainEqual({ type: "delta", content: "par" });
  });

  it("treats a stream that ends without a finish as a retryable failure", async () => {
    const adapter = scripted(async function* () {
      yield { type: "start", upstreamId: "u", model: "s" };
    }, healthy);
    await drain(await run(adapter));
    expect(adapter.calls).toHaveLength(2);
  });

  it("aborts a failed attempt's upstream call before retrying", async () => {
    const adapter = scripted(failsAfterStart, healthy);
    await drain(await run(adapter));
    expect(adapter.calls[0]?.signal.aborted).toBe(true);
    expect(adapter.calls[1]?.signal.aborted).toBe(false);
  });
});

describe("deadlines", () => {
  it("retries when the first token is too slow", async () => {
    const adapter = scripted(hangs, healthy);
    const events = await drain(
      await run(adapter, { config: { ...FAST_RESILIENCE, firstTokenMs: 10 } }),
    );
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]?.signal.aborted).toBe(true);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("counts time to first token from the start of the attempt, past the start event", async () => {
    const adapter = scripted(async function* (call) {
      yield { type: "start", upstreamId: "u", model: "s" };
      yield* hangs(call);
    });
    const config = { ...FAST_RESILIENCE, maxAttempts: 1, firstTokenMs: 10 };
    await expect(run(adapter, { config })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("times out a stall between tokens", async () => {
    const adapter = scripted(async function* (call) {
      yield { type: "start", upstreamId: "u", model: "s" };
      yield { type: "delta", content: "a" };
      yield* hangs(call);
    });
    const events = await run(adapter, { config: { ...FAST_RESILIENCE, stallMs: 10 } });
    await expect(drain(events)).rejects.toMatchObject({
      kind: "timeout",
      message: expect.stringContaining("stalled"),
    });
    expect(adapter.calls[0]?.signal.aborted).toBe(true);
  });

  it("walks away from an adapter that ignores the abort", async () => {
    const adapter = scripted(async function* () {
      yield* [];
      await new Promise(() => {});
    });
    const config = { ...FAST_RESILIENCE, maxAttempts: 1, firstTokenMs: 10 };
    await expect(run(adapter, { config })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("stops retrying at the total deadline, however many attempts remain", async () => {
    const adapter = scripted(hangs);
    const config = { ...FAST_RESILIENCE, maxAttempts: 100, firstTokenMs: 10, totalMs: 25 };
    await expect(run(adapter, { config })).rejects.toMatchObject({ kind: "timeout" });
    expect(adapter.calls.length).toBeLessThan(10);
  });

  it("names the total deadline when it is what ran out", async () => {
    const adapter = scripted(hangs);
    const config = { ...FAST_RESILIENCE, firstTokenMs: 1_000, totalMs: 10 };
    await expect(run(adapter, { config })).rejects.toMatchObject({
      kind: "timeout",
      message: expect.stringContaining("total deadline"),
    });
  });
});

describe("client disconnects", () => {
  it("does not retry once the client has gone", async () => {
    const client = new AbortController();
    const adapter = scripted(hangs);
    const attempt = run(adapter, { signal: client.signal });
    await vi.waitFor(() => expect(adapter.calls).toHaveLength(1));
    client.abort();
    await expect(attempt).rejects.toBeDefined();
    expect(adapter.calls).toHaveLength(1);
  });

  it("does not call upstream at all if the client is already gone", async () => {
    const adapter = scripted(healthy);
    await expect(run(adapter, { signal: AbortSignal.abort() })).rejects.toBeDefined();
    expect(adapter.calls).toHaveLength(0);
  });

  it("stops waiting during backoff", async () => {
    const client = new AbortController();
    const adapter = scripted(failsAtOnce);
    const attempt = run(adapter, {
      signal: client.signal,
      config: { ...FAST_RESILIENCE, backoffBaseMs: 60_000, backoffCapMs: 60_000 },
    });
    setTimeout(() => client.abort(), 10);
    const started = Date.now();
    await expect(attempt).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(adapter.calls).toHaveLength(1);
  });
});

describe("through the gateway and mock provider", () => {
  const app = testGateway();
  const chat = (body: Record<string, unknown>, chaos: string) =>
    app.request("/v1/chat/completions", chatRequest(body, { chaos }));

  it.each([
    "status=503; fail_attempts=1",
    "status=429; fail_attempts=2",
    "drop_after=0; fail_attempts=1",
    "malformed_after=0; fail_attempts=2",
    "error_after=0; fail_attempts=1",
  ])("hides %s from a streaming client", async (chaos) => {
    const res = await chat({ model: "mock/mock-echo", stream: true }, chaos);
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("x-switchboard-attempts"))).toBeGreaterThan(1);
    const events = await sseData(res);
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.filter((c) => c.choices[0]?.delta.role)).toHaveLength(1);
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe("hello gateway");
  });

  it("hides a mid-stream drop from a non-streaming client", async () => {
    const res = await chat({ model: "mock/mock-lorem" }, "drop_after=3; fail_attempts=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-switchboard-attempts")).toBe("2");
  });

  it("reports every attempt it used when it gives up", async () => {
    const res = await chat({ model: "mock/mock-lorem", stream: true }, "status=503");
    expect(res.status).toBe(502);
    expect(res.headers.get("x-switchboard-attempts")).toBe("3");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("does not retry a request upstream rejects", async () => {
    const res = await chat({ model: "mock/mock-lorem", stream: true }, "status=400");
    expect(res.status).toBe(400);
    expect(res.headers.get("x-switchboard-attempts")).toBe("1");
  });
});
