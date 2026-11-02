import { type CircuitBreaker, inMemoryCircuitBreaker } from "./circuit-breaker.js";
import {
  createRedis,
  failOpenCircuitBreaker,
  failOpenRetryBudget,
  redisCircuitBreaker,
  redisRetryBudget,
} from "./redis-stores.js";
import { inMemoryRetryBudget, type RetryBudget } from "./retry-budget.js";

export interface ResilienceStores {
  circuitBreaker: CircuitBreaker;
  retryBudget: RetryBudget;
}

/** Shared through Redis when configured; otherwise each instance keeps its own. */
export function createStores(redisUrl: string | undefined): ResilienceStores {
  if (!redisUrl) {
    return { circuitBreaker: inMemoryCircuitBreaker(), retryBudget: inMemoryRetryBudget() };
  }
  const redis = createRedis(redisUrl);
  // Connection problems reach callers as failed commands; without a listener
  // the client's error events would also crash the process.
  redis.on("error", () => {});
  redis.connect().catch(() => {});
  return {
    circuitBreaker: failOpenCircuitBreaker(redisCircuitBreaker(redis)),
    retryBudget: failOpenRetryBudget(redisRetryBudget(redis), inMemoryRetryBudget()),
  };
}
