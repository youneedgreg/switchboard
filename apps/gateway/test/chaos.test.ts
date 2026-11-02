/**
 * The chaos suite: every failure × every policy, then a large randomized run.
 * Everything crosses real sockets: client → gateway → mock provider, so a
 * dropped connection is a really dropped connection.
 *
 * The one thing being proved is that a client never receives a broken stream.
 * Whatever happens upstream, it gets either the complete, correct answer or a
 * clear error, and never anything in between. See `violations` for the rules.
 *
 * Billing and span assertions join this suite in Weeks 3 and 5.
 */
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { parseSse } from "@switchboard/core";
import { createMockApp } from "@switchboard/mock-provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway } from "../src/gateway.js";
import { openAICompatible } from "../src/providers/openai-compatible.js";
import type { ProviderRegistry } from "../src/providers/registry.js";
import { type CircuitBreaker, inMemoryCircuitBreaker } from "../src/resilience/circuit-breaker.js";
import type { ResilienceConfig } from "../src/resilience/policy.js";
import { inMemoryRetryBudget, type RetryBudget } from "../src/resilience/retry-budget.js";
import { NEVER_OPENS, TEST_KEY } from "./helpers.js";

const RUNS = Number(process.env.CHAOS_RUNS ?? 1_000);
const SEED = Number(process.env.CHAOS_SEED ?? 1);
const CONCURRENCY = 25;

const RESILIENCE: ResilienceConfig = {
  maxAttempts: 3,
  backoffBaseMs: 1,
  backoffCapMs: 3,
  maxRetryAfterMs: 5,
  firstTokenMs: 400,
  stallMs: 80,
  totalMs: 5_000,
};

/** What one upstream attempt does, as an x-mock-chaos value. */
type Fault = string;

interface Plan {
  faults: Fault[];
  /** Attempts seen for this run, with each one's abort signal. */
  signals: AbortSignal[];
}

const plans = new Map<string, Plan>();

let mockUrl: string;

/** Gives each attempt its own fault, which a single chaos header cannot. */
function plannedFetch(): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    const run = headers.get("x-chaos-run") ?? "";
    const plan = plans.get(run);
    const attempt = Number(headers.get("x-mock-attempt") ?? 1);
    if (plan) {
      if (init?.signal) plan.signals.push(init.signal);
      const fault = plan.faults[attempt - 1] ?? plan.faults.at(-1) ?? "";
      headers.set("x-mock-chaos", fault);
    }
    return fetch(input, { ...init, headers });
  };
}

function registry(): ProviderRegistry {
  const adapter = (name: string, resumeStyle: "prefix" | "prompt") =>
    openAICompatible({
      name,
      resumeStyle,
      baseUrl: mockUrl,
      models: ["mock-lorem"],
      forwardHeaders: ["x-chaos-run"],
      attemptHeader: "x-mock-attempt",
      fetch: plannedFetch(),
    });
  return new Map([
    ["mock", adapter("mock", "prefix")],
    ["mock-backup", adapter("mock-backup", "prompt")],
  ]);
}

const openServers: ServerType[] = [];

async function listen(fetchHandler: (request: Request) => Response | Promise<Response>) {
  const server = serve({ fetch: fetchHandler, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  openServers.push(server);
  return { server, port: (server.address() as AddressInfo).port };
}

async function startGateway(options: { budget?: RetryBudget; circuit?: CircuitBreaker } = {}) {
  const app = createGateway({
    apiKeys: [TEST_KEY],
    registry: registry(),
    resilience: RESILIENCE,
    retryBudget:
      options.budget ?? inMemoryRetryBudget({ ratio: 1, minPerSecond: 100_000, windowSeconds: 10 }),
    circuitBreaker: options.circuit ?? NEVER_OPENS,
  });
  const { port } = await listen(app.fetch);
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

beforeAll(async () => {
  const { port } = await listen(createMockApp().fetch);
  mockUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => {
  for (const server of openServers) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    server.close();
  }
});

interface Run {
  model: string;
  policy: "resume" | "abort";
  stream: boolean;
  includeUsage?: boolean;
  prompt: string;
  /** Applies to every attempt: the shape of the answer, not a fault. */
  tokens: number;
  faults: Fault[];
  /** Read this many SSE events, then disconnect. */
  cancelAfter?: number;
}

let runCounter = 0;

function send(url: string, run: Run, id: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_KEY}`,
      "content-type": "application/json",
      "x-chaos-run": id,
      "x-switchboard-mid-stream": run.policy,
    },
    body: JSON.stringify({
      model: run.model,
      stream: run.stream,
      ...(run.includeUsage ? { stream_options: { include_usage: true } } : {}),
      messages: [{ role: "user", content: run.prompt }],
    }),
    ...(signal ? { signal } : {}),
  });
}

/** The answer with no faults at all, which every completed run must match. */
const answers = new Map<string, string>();

async function expectedAnswer(url: string, prompt: string, tokens: number): Promise<string> {
  const key = `${prompt}|${tokens}`;
  const known = answers.get(key);
  if (known !== undefined) return known;
  const id = `clean-${runCounter++}`;
  plans.set(id, { faults: [`tokens=${tokens}`], signals: [] });
  const res = await send(
    url,
    { model: "mock-backup/mock-lorem", policy: "abort", stream: false, prompt, tokens, faults: [] },
    id,
  );
  plans.delete(id);
  if (!res.ok) throw new Error(`clean run failed: ${res.status}`);
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const answer = body.choices[0]?.message.content ?? "";
  answers.set(key, answer);
  return answer;
}

type Outcome =
  | { kind: "complete"; text: string; resumed: boolean; record?: Record<string, unknown> }
  | { kind: "in-band-error"; text: string; code: string; resumed: boolean }
  | { kind: "http-error"; status: number; code: string }
  | { kind: "cancelled" };

interface Checked {
  outcome: Outcome;
  violations: string[];
  attempts: number;
}

const HTTP_ERROR_CODES: Record<string, number[]> = {
  rate_limited: [429],
  server: [502],
  network: [502],
  protocol: [502],
  auth: [502],
  timeout: [504],
  bad_request: [400],
  circuit_open: [503],
};

interface SseChunk {
  id?: string;
  model?: string;
  error?: { code?: unknown; message?: unknown };
  switchboard?: Record<string, unknown>;
  choices?: Array<{
    delta: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
}

/** Decides whether what the client received was one coherent response. */
function violations(
  events: string[],
  status: number,
  expected: string,
): Checked["outcome"] & {
  problems: string[];
} {
  const problems: string[] = [];
  const parsed: SseChunk[] = [];
  let done = false;
  let afterTerminal = false;
  let error: { code?: unknown; message?: unknown } | undefined;

  for (const event of events) {
    if (done || error) afterTerminal = true;
    if (event === "[DONE]") {
      done = true;
      continue;
    }
    let chunk: SseChunk;
    try {
      chunk = JSON.parse(event);
    } catch {
      problems.push(`unparseable event reached the client: ${event.slice(0, 80)}`);
      continue;
    }
    if (chunk.error) error = chunk.error;
    else parsed.push(chunk);
  }

  if (status !== 200) problems.push(`stream with status ${status}`);
  if (afterTerminal) problems.push("events after the end of the stream");
  if (done && error) problems.push("both [DONE] and an error");
  if (!done && !error) problems.push("stream ended with neither [DONE] nor an error");
  if (error && (typeof error.code !== "string" || typeof error.message !== "string")) {
    problems.push(`malformed error event: ${JSON.stringify(error)}`);
  }

  if (new Set(parsed.map((c) => c.id)).size > 1) problems.push("more than one response id");
  if (new Set(parsed.map((c) => c.model)).size > 1) problems.push("more than one model name");

  const choices = parsed.flatMap((c) => c.choices ?? []);
  const roles = choices.filter((c) => c.delta.role);
  if (choices.length && roles.length !== 1) problems.push(`${roles.length} role chunks`);
  if (choices.length && !choices[0]?.delta.role) problems.push("first chunk has no role");

  const finishes = choices.filter((c) => c.finish_reason);
  if (finishes.length > 1) problems.push(`${finishes.length} finish chunks`);
  const finishIndex = choices.findIndex((c) => c.finish_reason);
  if (finishIndex !== -1 && finishIndex !== choices.length - 1) {
    problems.push("content after the finish chunk");
  }

  const text = choices.map((c) => c.delta.content ?? "").join("");
  const record = parsed.find((c) => c.switchboard)?.switchboard;

  if (done) {
    if (finishes.length !== 1) problems.push("[DONE] without a finish chunk");
    if (text !== expected) {
      problems.push(`wrong text.\n  got:      ${text}\n  expected: ${expected}`);
    }
    return { kind: "complete", text, resumed: Boolean(record), record, problems };
  }

  if (finishes.length) problems.push("an error after a finish chunk");
  if (!expected.startsWith(text)) {
    problems.push(`partial text is not a prefix.\n  got:      ${text}\n  expected: ${expected}`);
  }
  if (record) problems.push("a resume record on a stream that did not finish");
  return {
    kind: "in-band-error",
    text,
    code: String(error?.code),
    resumed: false,
    problems,
  };
}

async function execute(url: string, run: Run): Promise<Checked> {
  const id = `run-${runCounter++}`;
  const plan: Plan = { faults: run.faults, signals: [] };
  plans.set(id, plan);
  const expected = await expectedAnswer(url, run.prompt, run.tokens);

  const res = await send(url, run, id);
  const attempts = () => plan.signals.length;
  const problems: string[] = [];
  let outcome: Outcome;

  try {
    if (res.headers.get("content-type")?.includes("application/json")) {
      const body = (await res.json()) as {
        error?: { code?: string };
        choices?: Array<{ message: { content: string }; finish_reason: string }>;
      };
      if (res.status === 200) {
        const text = body.choices?.[0]?.message.content;
        if (text !== expected)
          problems.push(`wrong text.\n  got: ${text}\n  expected: ${expected}`);
        if (body.choices?.[0]?.finish_reason !== "stop") problems.push("no finish reason");
        outcome = { kind: "complete", text: text ?? "", resumed: false };
      } else {
        const code = String(body.error?.code);
        const allowed = HTTP_ERROR_CODES[code];
        if (!allowed) problems.push(`unknown error code ${code}`);
        else if (!allowed.includes(res.status)) problems.push(`${code} with status ${res.status}`);
        outcome = { kind: "http-error", status: res.status, code };
      }
    } else if (run.cancelAfter !== undefined) {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (let i = 0; i < run.cancelAfter; i++) {
        const { done } = await reader.read();
        if (done) break;
      }
      await reader.cancel();
      // Give the disconnect time to reach the gateway and then upstream.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const seen = plan.signals.length;
      const running = plan.signals.filter((signal) => !signal.aborted).length;
      if (running > 0) problems.push(`${running} upstream calls left running`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (plan.signals.length !== seen) problems.push("new attempts after the client left");
      outcome = { kind: "cancelled" };
    } else {
      const events: string[] = [];
      for await (const message of parseSse(res.body as ReadableStream<Uint8Array>)) {
        events.push(message.data);
      }
      const { problems: found, ...result } = violations(events, res.status, expected);
      problems.push(...found);
      outcome = result as Outcome;
    }
  } catch (error) {
    problems.push(`client saw a transport failure: ${String(error)}`);
    outcome = { kind: "cancelled" };
  } finally {
    plans.delete(id);
  }

  return { outcome, violations: problems, attempts: attempts() };
}

/** A fault that ends the attempt before its first token, or at token `at`. */
const faultAt = {
  drop: (at: number) => `drop_after=${at}`,
  stall: (at: number) => `stall_after=${at}`,
  malformed: (at: number) => `malformed_after=${at}`,
  inStreamError: (at: number) => `error_after=${at}`,
};

const TOKENS = 12;
const shape = `tokens=${TOKENS}`;
const healthy = shape;
const withShape = (fault: string) => `${fault}; ${shape}`;

const PRE_COMMIT: Array<[string, Fault]> = [
  ["503", "status=503"],
  ["500", "status=500"],
  ["429", "status=429"],
  ["429 with a long Retry-After", "status=429; retry_after=60"],
  ["401", "status=401"],
  ["slow first token", "ttft_ms=1000"],
  ["drop before the first token", faultAt.drop(0)],
  ["stall before the first token", faultAt.stall(0)],
  ["malformed before the first token", faultAt.malformed(0)],
  ["in-stream error before the first token", faultAt.inStreamError(0)],
];

const MID_STREAM: Array<[string, Fault, string]> = [
  ["drop", faultAt.drop(5), "network"],
  ["stall", faultAt.stall(5), "timeout"],
  ["malformed chunk", faultAt.malformed(5), "protocol"],
  ["in-stream error", faultAt.inStreamError(5), "server"],
  ["drop on the last token", faultAt.drop(TOKENS - 1), "network"],
];

const POLICIES = ["resume", "abort"] as const;
const MODELS = ["mock/mock-lorem", "route/demo"] as const;
const OVERLAPS = ["", "; resume_overlap=20", "; resume_overlap=1000000"];

describe("chaos matrix", () => {
  let url: string;
  beforeAll(async () => {
    url = await startGateway();
  });
  const base = { prompt: "the matrix prompt", tokens: TOKENS };

  describe.each(POLICIES)("policy %s", (policy) => {
    describe.each(MODELS)("%s", (model) => {
      const isRoute = model === "route/demo";

      it.each(PRE_COMMIT)("streaming: hides a passing %s", async (_name, fault) => {
        const { outcome, violations: problems } = await execute(url, {
          ...base,
          model,
          policy,
          stream: true,
          faults: [withShape(fault), healthy],
        });
        expect(problems).toEqual([]);
        // Without a fallback, these give up rather than retry.
        const stops = !isRoute && (fault === "status=401" || fault.includes("retry_after=60"));
        expect(outcome.kind).toBe(stops ? "http-error" : "complete");
        if (outcome.kind === "complete") expect(outcome.resumed).toBe(false);
      });

      it.each(PRE_COMMIT)("non-streaming: hides a passing %s", async (_name, fault) => {
        const { outcome, violations: problems } = await execute(url, {
          ...base,
          model,
          policy,
          stream: false,
          faults: [withShape(fault), healthy],
        });
        expect(problems).toEqual([]);
        const stops = !isRoute && (fault === "status=401" || fault.includes("retry_after=60"));
        expect(outcome.kind).toBe(stops ? "http-error" : "complete");
      });

      it.each(PRE_COMMIT)("reports a %s that never clears", async (_name, fault) => {
        const { outcome, violations: problems } = await execute(url, {
          ...base,
          model,
          policy,
          stream: true,
          faults: [withShape(fault)],
        });
        expect(problems).toEqual([]);
        expect(outcome.kind).toBe("http-error");
      });

      it.each(MID_STREAM)("streaming: handles a %s mid-stream", async (_name, fault, code) => {
        for (const overlap of policy === "resume" ? OVERLAPS : [""]) {
          const { outcome, violations: problems } = await execute(url, {
            ...base,
            model,
            policy,
            stream: true,
            faults: [withShape(fault), healthy + overlap],
          });
          expect(problems).toEqual([]);
          if (policy === "resume") {
            expect(outcome).toMatchObject({ kind: "complete", resumed: true });
          } else {
            expect(outcome).toMatchObject({ kind: "in-band-error", code });
          }
        }
      });

      it.each(MID_STREAM)("non-streaming: hides a %s mid-stream", async (_name, fault) => {
        const { outcome, violations: problems } = await execute(url, {
          ...base,
          model,
          policy,
          stream: false,
          faults: [withShape(fault), healthy],
        });
        expect(problems).toEqual([]);
        expect(outcome).toMatchObject({ kind: "complete", resumed: false });
      });

      // Long enough that resuming can't finish it in the attempts allowed.
      it.each(MID_STREAM.slice(0, 4))(
        "reports a %s that keeps happening",
        async (_name, fault, code) => {
          const tokens = 40;
          const { outcome, violations: problems } = await execute(url, {
            ...base,
            tokens,
            model,
            policy,
            stream: true,
            faults: [`${fault}; tokens=${tokens}`],
          });
          expect(problems).toEqual([]);
          expect(outcome).toMatchObject({ kind: "in-band-error", code });
        },
      );

      it("finishes when a retried drop only ever cost the last token", async () => {
        const { outcome, violations: problems } = await execute(url, {
          ...base,
          model,
          policy,
          stream: true,
          faults: [withShape(faultAt.drop(TOKENS - 1))],
        });
        expect(problems).toEqual([]);
        expect(outcome.kind).toBe(policy === "resume" ? "complete" : "in-band-error");
      });

      it("never retries or falls back from a bad request", async () => {
        const {
          outcome,
          violations: problems,
          attempts,
        } = await execute(url, {
          ...base,
          model,
          policy,
          stream: true,
          faults: [withShape("status=400"), healthy],
        });
        expect(problems).toEqual([]);
        expect(outcome).toMatchObject({ kind: "http-error", status: 400 });
        expect(attempts).toBe(1);
      });

      it.each([0, 1, 3])(
        "stops upstream when the client leaves after %i events",
        async (events) => {
          const { outcome, violations: problems } = await execute(url, {
            ...base,
            model,
            policy,
            stream: true,
            faults: [withShape(`token_ms=20; ${faultAt.stall(8)}`)],
            cancelAfter: events,
          });
          expect(problems).toEqual([]);
          expect(outcome.kind).toBe("cancelled");
        },
      );
    });
  });
});

/** Small seeded generator, so that any failing run can be replayed. */
function randomFrom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

function randomRun(seed: number): Run {
  const random = randomFrom(seed);
  // A client that leaves must leave mid-answer, so its answers are long and slow.
  const cancels = random.next() < 0.05;
  const tokens = cancels ? 40 : 1 + random.int(40);
  const pace = cancels ? "; token_ms=20" : "";
  const overlap = random.pick([
    "",
    "",
    "; resume_overlap=20",
    "; resume_overlap=25",
    "; resume_overlap=1000000",
  ]);
  const at = () => random.int(tokens + 1);
  const fault = (): Fault => {
    const kind = random.int(13);
    switch (kind) {
      case 0:
        return "status=503";
      case 1:
        return "status=500";
      case 2:
        return "status=429";
      case 3:
        return `status=429; retry_after=${random.pick([0, 1, 60])}`;
      case 4:
        return random.next() < 0.3 ? "status=401" : "status=502";
      case 5:
        return "ttft_ms=1000";
      case 6:
        return `token_ms=120; drop_after=${at()}`;
      case 7:
        return faultAt.stall(at());
      case 8:
        return faultAt.malformed(at());
      case 9:
        return faultAt.inStreamError(at());
      case 10:
        return random.next() < 0.1 ? "status=400" : faultAt.drop(at());
      default:
        return faultAt.drop(at());
    }
  };
  // Mostly a few failures then success, sometimes everything failing.
  const failures = random.pick([0, 1, 1, 2, 2, 3, 4, 5, 8]);
  const faults = Array.from(
    { length: failures },
    () => `${fault()}; tokens=${tokens}${overlap}${pace}`,
  );
  faults.push(`tokens=${tokens}${overlap}${pace}`);
  const stream = cancels || random.next() < 0.85;
  return {
    model: random.pick(MODELS),
    policy: random.next() < 0.75 ? "resume" : "abort",
    stream,
    includeUsage: random.next() < 0.3,
    prompt: `chaos prompt ${random.int(5)}`,
    tokens,
    faults,
    ...(cancels ? { cancelAfter: random.int(6) } : {}),
  };
}

async function campaign(url: string, runs: number, firstSeed: number) {
  const tally: Record<string, number> = {};
  const broken: Array<{ seed: number; run: Run; outcome: Outcome; problems: string[] }> = [];
  let resumed = 0;
  let attempts = 0;
  let seed = firstSeed;
  const end = firstSeed + runs;

  const worker = async () => {
    while (seed < end) {
      const current = seed++;
      const run = randomRun(current);
      const result = await execute(url, run);
      tally[result.outcome.kind] = (tally[result.outcome.kind] ?? 0) + 1;
      attempts += result.attempts;
      if ("resumed" in result.outcome && result.outcome.resumed) resumed++;
      if (result.violations.length) {
        broken.push({
          seed: current,
          run,
          outcome: result.outcome,
          problems: result.violations,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { tally, broken, resumed, attempts };
}

const report = (name: string, runs: number, result: Awaited<ReturnType<typeof campaign>>) => {
  const { tally, broken, resumed, attempts } = result;
  console.log(
    `${name}: ${runs} runs, ${broken.length} broken, ${attempts} upstream attempts, ` +
      `${resumed} resumed, outcomes ${JSON.stringify(tally)}`,
  );
  for (const { seed, run, problems } of broken.slice(0, 5)) {
    console.error(`seed ${seed}: ${JSON.stringify(run)}\n  ${problems.join("\n  ")}`);
  }
};

describe("randomized chaos", () => {
  it(`gives ${RUNS} clients only complete answers or clear errors`, async () => {
    const url = await startGateway();
    const result = await campaign(url, RUNS, SEED);
    report("no breaker", RUNS, result);
    expect(result.broken).toEqual([]);
    // Guards against a suite that passes by never exercising anything.
    if (RUNS >= 200) {
      expect(result.resumed).toBeGreaterThan(RUNS / 20);
      expect(result.tally.complete).toBeGreaterThan(RUNS / 3);
      expect(result.tally["in-band-error"]).toBeGreaterThan(0);
      expect(result.tally["http-error"]).toBeGreaterThan(0);
    }
  }, 600_000);

  it("stays coherent with a live circuit breaker and a tight retry budget", async () => {
    const url = await startGateway({
      budget: inMemoryRetryBudget({ ratio: 0.1, minPerSecond: 1, windowSeconds: 10 }),
      circuit: inMemoryCircuitBreaker({
        minFailures: 15,
        failureRatio: 0.7,
        windowMs: 500,
        cooldownMs: 20,
        probeLeaseMs: 100,
      }),
    });
    const runs = Math.ceil(RUNS / 4);
    const result = await campaign(url, runs, SEED + 1_000_000);
    report("live breaker", runs, result);
    expect(result.broken).toEqual([]);
    if (runs >= 100) {
      expect(result.tally.complete).toBeGreaterThan(runs / 10);
      expect(result.tally["http-error"]).toBeGreaterThan(0);
    }
  }, 600_000);
});
