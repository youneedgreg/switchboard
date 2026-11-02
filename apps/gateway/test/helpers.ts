import { parseSse } from "@switchboard/core";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/gateway.js";
import { buildRegistry } from "../src/providers/registry.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import {
  DEFAULT_CIRCUIT_BREAKER,
  inMemoryCircuitBreaker,
} from "../src/resilience/circuit-breaker.js";
import { DEFAULT_RESILIENCE, type ResilienceConfig } from "../src/resilience/policy.js";
import { inMemoryRetryBudget } from "../src/resilience/retry-budget.js";

export const TEST_KEY = "sb_test_0123456789abcdef";

export const NEVER_OPENS = inMemoryCircuitBreaker({
  ...DEFAULT_CIRCUIT_BREAKER,
  minFailures: Number.POSITIVE_INFINITY,
});

export const FAST_RESILIENCE: ResilienceConfig = {
  ...DEFAULT_RESILIENCE,
  backoffBaseMs: 1,
  backoffCapMs: 2,
};

export function testGateway(...extra: ProviderAdapter[]) {
  return testGatewayWith(FAST_RESILIENCE, ...extra);
}

export function testGatewayWith(resilience: ResilienceConfig, ...extra: ProviderAdapter[]) {
  const registry = new Map(buildRegistry(loadConfig({ GATEWAY_API_KEYS: TEST_KEY })));
  for (const adapter of extra) registry.set(adapter.name, adapter);
  return createGateway({
    apiKeys: [TEST_KEY],
    registry,
    resilience,
    retryBudget: inMemoryRetryBudget({ ratio: 1, minPerSecond: 1_000, windowSeconds: 10 }),
    circuitBreaker: NEVER_OPENS,
  });
}

export function chatRequest(
  body: Record<string, unknown>,
  options: { chaos?: string; midStream?: string; signal?: AbortSignal } = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_KEY}`,
      "content-type": "application/json",
      ...(options.chaos ? { "x-mock-chaos": options.chaos } : {}),
      ...(options.midStream ? { "x-switchboard-mid-stream": options.midStream } : {}),
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello gateway" }], ...body }),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

export async function sseData(res: Response): Promise<string[]> {
  const out: string[] = [];
  for await (const message of parseSse(res.body as ReadableStream<Uint8Array>)) {
    out.push(message.data);
  }
  return out;
}
