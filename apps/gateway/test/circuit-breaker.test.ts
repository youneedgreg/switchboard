/**
 * Both circuit breakers and both retry budgets must behave the same, so one set
 * of tests runs against the in-memory versions and against real Redis.
 */
import { ProviderError, type StreamEvent } from "@switchboard/core";
import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/gateway.js";
import type { ProviderAdapter, ProviderCall } from "../src/providers/types.js";
import { runAttempts } from "../src/resilience/attempts.js";
import {
  type CircuitBreaker,
  type CircuitBreakerConfig,
  inMemoryCircuitBreaker,
} from "../src/resilience/circuit-breaker.js";
import {
  createRedis,
  failOpenCircuitBreaker,
  failOpenRetryBudget,
  redisCircuitBreaker,
  redisRetryBudget,
} from "../src/resilience/redis-stores.js";
import {
  inMemoryRetryBudget,
  type RetryBudget,
  type RetryBudgetConfig,
} from "../src/resilience/retry-budget.js";
import { chatRequest, FAST_RESILIENCE, TEST_KEY } from "./helpers.js";

const CONFIG: CircuitBreakerConfig = {
  minFailures: 3,
  failureRatio: 0.5,
  windowMs: 1_000,
  cooldownMs: 500,
  probeLeaseMs: 200,
};
const BUDGET: RetryBudgetConfig = { ratio: 0.1, minPerSecond: 1, windowSeconds: 10 };

let container: StartedTestContainer;
let redis: Redis;
let unique = 0;

beforeAll(async () => {
  container = await new GenericContainer("redis:8.8.3").withExposedPorts(6379).start();
  redis = new Redis(container.getMappedPort(6379), container.getHost());
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

const circuits: Array<[string, (now: () => number) => CircuitBreaker]> = [
  ["in memory", (now) => inMemoryCircuitBreaker(CONFIG, now)],
  ["Redis", (now) => redisCircuitBreaker(redis, CONFIG, now, `test${unique++}`)],
];

describe.each(circuits)("circuit breaker (%s)", (_name, create) => {
  const setup = () => {
    const clock = { now: 1_000_000 };
    return { clock, circuit: create(() => clock.now) };
  };
  const fail = async (circuit: CircuitBreaker, times: number) => {
    for (let i = 0; i < times; i++) await circuit.record("p", "failure");
  };

  it("starts closed", async () => {
    const { circuit } = setup();
    expect(await circuit.state("p")).toBe("closed");
    expect(await circuit.allow("p")).toEqual({ allowed: true });
  });

  it("opens at the failure threshold, and says when to come back", async () => {
    const { circuit, clock } = setup();
    await fail(circuit, 2);
    expect(await circuit.state("p")).toBe("closed");
    await fail(circuit, 1);
    expect(await circuit.state("p")).toBe("open");
    clock.now += 100;
    expect(await circuit.allow("p")).toEqual({ allowed: false, retryAfterMs: 400 });
  });

  it("stays closed while most calls succeed", async () => {
    const { circuit } = setup();
    for (let i = 0; i < 4; i++) await circuit.record("p", "success");
    await fail(circuit, 3);
    expect(await circuit.state("p")).toBe("closed");
  });

  it("forgets failures from an earlier window", async () => {
    const { circuit, clock } = setup();
    await circuit.record("p", "success");
    await fail(circuit, 2);
    clock.now += CONFIG.windowMs;
    await fail(circuit, 2);
    expect(await circuit.state("p")).toBe("closed");
  });

  it("keeps providers separate", async () => {
    const { circuit } = setup();
    await fail(circuit, 3);
    expect(await circuit.allow("other")).toEqual({ allowed: true });
  });

  it("lets exactly one probe through after the cooldown", async () => {
    const { circuit, clock } = setup();
    await fail(circuit, 3);
    clock.now += CONFIG.cooldownMs;
    expect(await circuit.allow("p")).toEqual({ allowed: true });
    expect(await circuit.state("p")).toBe("half_open");
    expect(await circuit.allow("p")).toMatchObject({ allowed: false });
  });

  it("closes when the probe succeeds, with a clean slate", async () => {
    const { circuit, clock } = setup();
    await fail(circuit, 3);
    clock.now += CONFIG.cooldownMs;
    await circuit.allow("p");
    await circuit.record("p", "success");
    expect(await circuit.state("p")).toBe("closed");
    await fail(circuit, 2);
    expect(await circuit.state("p")).toBe("closed");
  });

  it("reopens for a full cooldown when the probe fails", async () => {
    const { circuit, clock } = setup();
    await fail(circuit, 3);
    clock.now += CONFIG.cooldownMs;
    await circuit.allow("p");
    await circuit.record("p", "failure");
    expect(await circuit.state("p")).toBe("open");
    expect(await circuit.allow("p")).toEqual({ allowed: false, retryAfterMs: CONFIG.cooldownMs });
  });

  it("gives a new request the probe if the first never reports back", async () => {
    const { circuit, clock } = setup();
    await fail(circuit, 3);
    clock.now += CONFIG.cooldownMs;
    await circuit.allow("p");
    clock.now += CONFIG.probeLeaseMs;
    expect(await circuit.allow("p")).toEqual({ allowed: true });
  });

  it("does not extend the cooldown on late results from calls already running", async () => {
    const { circuit, clock } = setup();
    await fail(circuit, 3);
    clock.now += 100;
    await fail(circuit, 1);
    await circuit.record("p", "success");
    expect(await circuit.state("p")).toBe("open");
    expect(await circuit.allow("p")).toEqual({ allowed: false, retryAfterMs: 400 });
  });
});

const budgets: Array<[string, (now: () => number, config?: RetryBudgetConfig) => RetryBudget]> = [
  ["in memory", (now, config = BUDGET) => inMemoryRetryBudget(config, now)],
  ["Redis", (now, config = BUDGET) => redisRetryBudget(redis, config, now, `test${unique++}`)],
];

describe.each(budgets)("retry budget (%s)", (_name, create) => {
  const count = async (budget: RetryBudget, attempts: number) => {
    let allowed = 0;
    for (let i = 0; i < attempts; i++) if (await budget.tryRetry("p")) allowed++;
    return allowed;
  };

  it("allows the reserve with no traffic", async () => {
    expect(
      await count(
        create(() => 5_000_000),
        15,
      ),
    ).toBe(10);
  });

  it("grows with traffic at the configured ratio", async () => {
    const budget = create(() => 5_000_000, { ...BUDGET, minPerSecond: 0 });
    for (let i = 0; i < 100; i++) await budget.recordRequest("p");
    expect(await count(budget, 15)).toBe(10);
  });

  it("recovers once spent retries have left the window", async () => {
    const clock = { now: 5_000_000 };
    const budget = create(() => clock.now);
    expect(await count(budget, 15)).toBe(10);
    expect(await budget.tryRetry("p")).toBe(false);
    clock.now += 20_000;
    expect(await budget.tryRetry("p")).toBe(true);
  });

  it("keeps providers separate", async () => {
    const budget = create(() => 5_000_000);
    await count(budget, 15);
    expect(await budget.tryRetry("other")).toBe(true);
  });
});

describe("the Redis stores are shared", () => {
  it("lets one instance see the circuit another opened", async () => {
    const clock = { now: 1_000_000 };
    const prefix = `test${unique++}`;
    const first = redisCircuitBreaker(redis, CONFIG, () => clock.now, prefix);
    const second = redisCircuitBreaker(redis, CONFIG, () => clock.now, prefix);
    for (let i = 0; i < 3; i++) await first.record("p", "failure");
    expect(await second.allow("p")).toMatchObject({ allowed: false });
  });

  it("gives only one of many concurrent requests the probe", async () => {
    const clock = { now: 1_000_000 };
    const circuit = redisCircuitBreaker(redis, CONFIG, () => clock.now, `test${unique++}`);
    for (let i = 0; i < 3; i++) await circuit.record("p", "failure");
    clock.now += CONFIG.cooldownMs;
    const decisions = await Promise.all(Array.from({ length: 50 }, () => circuit.allow("p")));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(1);
  });

  it("never over-spends the budget under concurrency", async () => {
    const budget = redisRetryBudget(redis, BUDGET, () => 5_000_000, `test${unique++}`);
    const results = await Promise.all(Array.from({ length: 100 }, () => budget.tryRetry("p")));
    expect(results.filter(Boolean)).toHaveLength(10);
  });
});

describe("when Redis is unavailable", () => {
  // Nothing listens on this port.
  const down = () => {
    const client = createRedis("redis://127.0.0.1:1");
    client.on("error", () => {});
    client.connect().catch(() => {});
    return client;
  };

  it("fails open, quickly, and warns only once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = down();
    const circuit = failOpenCircuitBreaker(redisCircuitBreaker(client));
    const started = Date.now();
    expect(await circuit.allow("p")).toEqual({ allowed: true });
    await circuit.record("p", "failure");
    expect(await circuit.state("p")).toBe("closed");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warn).toHaveBeenCalledTimes(1);
    client.disconnect();
    warn.mockRestore();
  });

  it("falls back to this instance's own retry budget, still capped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = down();
    const budget = failOpenRetryBudget(
      redisRetryBudget(client),
      inMemoryRetryBudget({ ratio: 0, minPerSecond: 0.1, windowSeconds: 10 }),
    );
    expect(await budget.tryRetry("p")).toBe(true);
    expect(await budget.tryRetry("p")).toBe(false);
    client.disconnect();
    warn.mockRestore();
  });

  it("recovers by itself when Redis returns", async () => {
    const running = await new GenericContainer("redis:8.8.3").withExposedPorts(6379).start();
    const client = createRedis(`redis://${running.getHost()}:${running.getMappedPort(6379)}`);
    client.on("error", () => {});
    await client.connect();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const circuit = failOpenCircuitBreaker(redisCircuitBreaker(client, CONFIG));
    for (let i = 0; i < 3; i++) await circuit.record("p", "failure");
    expect(await circuit.state("p")).toBe("open");
    // Drops the connection and leaves the client to reconnect by itself.
    client.disconnect(true);
    expect(await circuit.allow("p")).toEqual({ allowed: true });
    await vi.waitFor(
      async () => expect(await circuit.allow("p")).toMatchObject({ allowed: false }),
      {
        timeout: 5_000,
      },
    );
    warn.mockRestore();
    client.disconnect();
    await running.stop();
  }, 120_000);
});

describe("in the attempt loop", () => {
  const healthy = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "start", upstreamId: "u", model: "s" };
    yield { type: "delta", content: "ok" };
    yield { type: "finish", reason: "stop" };
  };
  const failing = (kind: "server" | "bad_request" = "server") =>
    async function* (): AsyncGenerator<StreamEvent> {
      yield* [];
      throw new ProviderError({ provider: "p", kind, message: "boom" });
    };

  function adapter(
    name: string,
    run: (call: ProviderCall) => AsyncGenerator<StreamEvent>,
  ): ProviderAdapter & { calls: number } {
    return {
      name,
      models: ["s"],
      resumeStyle: "prompt",
      calls: 0,
      stream(call) {
        this.calls++;
        return run(call);
      },
    };
  }

  const opened = async (name: string, circuit: CircuitBreaker) => {
    for (let i = 0; i < CONFIG.minFailures; i++) await circuit.record(name, "failure");
  };

  const run = (circuit: CircuitBreaker, ...adapters: ProviderAdapter[]) =>
    runAttempts({
      targets: adapters.map((a) => ({ adapter: a, upstreamModel: "s" })),
      body: { model: "x", messages: [{ role: "user", content: "x" }] },
      headers: new Headers(),
      signal: new AbortController().signal,
      commitOn: "first-token",
      midStream: "resume",
      config: FAST_RESILIENCE,
      budget: inMemoryRetryBudget({ ratio: 1, minPerSecond: 1_000, windowSeconds: 10 }),
      circuit,
    });

  it("skips a provider whose circuit is open, without calling it", async () => {
    const circuit = inMemoryCircuitBreaker(CONFIG);
    await opened("primary", circuit);
    const primary = adapter("primary", healthy);
    const backup = adapter("backup", healthy);
    await run(circuit, primary, backup);
    expect(primary.calls).toBe(0);
    expect(backup.calls).toBe(1);
  });

  it("fails fast with circuit_open when the last provider's circuit is open", async () => {
    const circuit = inMemoryCircuitBreaker(CONFIG);
    await opened("only", circuit);
    const only = adapter("only", healthy);
    await expect(run(circuit, only)).rejects.toMatchObject({
      kind: "circuit_open",
      retryAfterMs: expect.any(Number),
    });
    expect(only.calls).toBe(0);
  });

  it("opens from a failing provider's attempts, and stops retrying it", async () => {
    const circuit = inMemoryCircuitBreaker({ ...CONFIG, minFailures: 2 });
    const primary = adapter("primary", failing());
    const backup = adapter("backup", healthy);
    await run(circuit, primary, backup);
    expect(primary.calls).toBe(2);
    expect(await circuit.state("primary")).toBe("open");
    expect(backup.calls).toBe(1);
  });

  it("does not hold a bad request against the provider", async () => {
    const circuit = inMemoryCircuitBreaker({ ...CONFIG, minFailures: 1 });
    await expect(run(circuit, adapter("p", failing("bad_request")))).rejects.toBeDefined();
    expect(await circuit.state("p")).toBe("closed");
  });

  it("closes again when a probe commits", async () => {
    const clock = { now: 0 };
    const circuit = inMemoryCircuitBreaker(CONFIG, () => clock.now);
    await opened("p", circuit);
    clock.now = CONFIG.cooldownMs;
    await run(circuit, adapter("p", healthy));
    expect(await circuit.state("p")).toBe("closed");
  });

  it("returns 503 with Retry-After through the gateway", async () => {
    const circuit = inMemoryCircuitBreaker(CONFIG);
    await opened("only", circuit);
    const only = adapter("only", healthy);
    const app = createGateway({
      apiKeys: [TEST_KEY],
      registry: new Map([["only", only]]),
      circuitBreaker: circuit,
    });
    const res = await app.request("/v1/chat/completions", chatRequest({ model: "only/s" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("circuit_open");
    expect(only.calls).toBe(0);
  });
});
