/**
 * The circuit breaker and retry budget shared across instances through Redis,
 * which serverless needs: each instance alone sees too little traffic to judge.
 *
 * Each operation is one Lua script, so it is atomic and takes one round trip.
 */
import { Redis } from "ioredis";
import type {
  CircuitBreaker,
  CircuitBreakerConfig,
  CircuitDecision,
  CircuitOutcome,
  CircuitState,
} from "./circuit-breaker.js";
import { DEFAULT_CIRCUIT_BREAKER } from "./circuit-breaker.js";
import { DEFAULT_RETRY_BUDGET, type RetryBudget, type RetryBudgetConfig } from "./retry-budget.js";

/** Long enough that expiry only ever clears circuits and counters nobody is using. */
const KEY_TTL_MS = 3_600_000;

export function createRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    // Resilience state must never hold a request up: fail fast and let the
    // caller carry on without it.
    commandTimeout: 250,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

/** Scripts read state as: [state, failures, successes, windowStart, until]. */
const ALLOW = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state or state == 'closed' then return {1, 0} end
local now = tonumber(ARGV[1])
local untilTime = tonumber(redis.call('HGET', KEYS[1], 'until'))
if now < untilTime then return {0, untilTime - now} end
redis.call('HSET', KEYS[1], 'state', 'half_open', 'until', now + tonumber(ARGV[2]))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return {1, 0}
`;

const RECORD = `
local now = tonumber(ARGV[1])
local success = ARGV[2] == 'success'
local minFailures = tonumber(ARGV[3])
local failureRatio = tonumber(ARGV[4])
local windowMs = tonumber(ARGV[5])
local cooldownMs = tonumber(ARGV[6])
local ttl = tonumber(ARGV[7])

local function reset(state, untilTime)
  redis.call('HSET', KEYS[1], 'state', state, 'failures', 0, 'successes', 0,
    'windowStart', now, 'until', untilTime)
  redis.call('PEXPIRE', KEYS[1], ttl)
end

local state = redis.call('HGET', KEYS[1], 'state')
if state == 'open' then return 0 end
if state == 'half_open' then
  if success then reset('closed', 0) else reset('open', now + cooldownMs) end
  return 0
end
local windowStart = tonumber(redis.call('HGET', KEYS[1], 'windowStart'))
if not state or now >= windowStart + windowMs then reset('closed', 0) end

if success then
  redis.call('HINCRBY', KEYS[1], 'successes', 1)
  return 0
end
local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
local successes = tonumber(redis.call('HGET', KEYS[1], 'successes'))
if failures >= minFailures and failures / (failures + successes) >= failureRatio then
  reset('open', now + cooldownMs)
end
return 0
`;

export function redisCircuitBreaker(
  redis: Redis,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER,
  now: () => number = Date.now,
  prefix = "sb",
): CircuitBreaker {
  const key = (provider: string) => `${prefix}:circuit:${provider}`;
  return {
    async allow(provider): Promise<CircuitDecision> {
      const [allowed, retryAfterMs] = (await redis.eval(
        ALLOW,
        1,
        key(provider),
        now(),
        config.probeLeaseMs,
        KEY_TTL_MS,
      )) as [number, number];
      return allowed ? { allowed: true } : { allowed: false, retryAfterMs };
    },
    async record(provider, outcome: CircuitOutcome) {
      await redis.eval(
        RECORD,
        1,
        key(provider),
        now(),
        outcome,
        config.minFailures,
        config.failureRatio,
        config.windowMs,
        config.cooldownMs,
        KEY_TTL_MS,
      );
    },
    async state(provider) {
      return ((await redis.hget(key(provider), "state")) ?? "closed") as CircuitState;
    },
  };
}

/**
 * Two fixed windows, with the previous one counted in proportion to how much of
 * it still overlaps the sliding window. A close approximation in two counters.
 */
const WINDOW_COUNT = `
local function count(key, weight)
  return (tonumber(redis.call('GET', key)) or 0) * weight
end
`;

const RECORD_REQUEST = `
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
return 0
`;

const TRY_RETRY = `${WINDOW_COUNT}
local previousWeight = tonumber(ARGV[1])
local reserve = tonumber(ARGV[2])
local ratio = tonumber(ARGV[3])
local requests = count(KEYS[1], 1) + count(KEYS[2], previousWeight)
local retries = count(KEYS[3], 1) + count(KEYS[4], previousWeight)
if retries >= reserve + ratio * requests then return 0 end
redis.call('INCR', KEYS[3])
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[4]))
return 1
`;

export function redisRetryBudget(
  redis: Redis,
  config: RetryBudgetConfig = DEFAULT_RETRY_BUDGET,
  now: () => number = Date.now,
  prefix = "sb",
): RetryBudget {
  const windowMs = config.windowSeconds * 1000;
  const ttl = windowMs * 3;
  const windows = () => {
    const time = now();
    const index = Math.floor(time / windowMs);
    return { index, previousWeight: 1 - (time % windowMs) / windowMs };
  };
  const key = (kind: string, provider: string, index: number) =>
    `${prefix}:budget:${provider}:${kind}:${index}`;

  return {
    async recordRequest(provider) {
      await redis.eval(RECORD_REQUEST, 1, key("requests", provider, windows().index), ttl);
    },
    async tryRetry(provider) {
      const { index, previousWeight } = windows();
      const allowed = await redis.eval(
        TRY_RETRY,
        4,
        key("requests", provider, index),
        key("requests", provider, index - 1),
        key("retries", provider, index),
        key("retries", provider, index - 1),
        previousWeight,
        config.minPerSecond * config.windowSeconds,
        config.ratio,
        ttl,
      );
      return allowed === 1;
    },
  };
}

/** Warns at most this often, since an outage would otherwise warn per request. */
const WARNING_INTERVAL_MS = 60_000;

function warner(name: string) {
  let lastWarning = 0;
  return (error: unknown) => {
    if (Date.now() - lastWarning < WARNING_INTERVAL_MS) return;
    lastWarning = Date.now();
    console.warn(`${name} is unavailable; continuing without it`, error);
  };
}

/** A Redis outage must not become a gateway outage: act as if nothing is wrong. */
export function failOpenCircuitBreaker(inner: CircuitBreaker): CircuitBreaker {
  const warn = warner("Circuit breaker store");
  return {
    allow: (provider) =>
      inner.allow(provider).catch((error): CircuitDecision => {
        warn(error);
        return { allowed: true };
      }),
    record: (provider, outcome) => inner.record(provider, outcome).catch(warn),
    state: (provider) =>
      inner.state(provider).catch((error): CircuitState => {
        warn(error);
        return "closed";
      }),
  };
}

export function failOpenRetryBudget(inner: RetryBudget, fallback: RetryBudget): RetryBudget {
  const warn = warner("Retry budget store");
  return {
    recordRequest: (provider) =>
      inner.recordRequest(provider).catch((error) => {
        warn(error);
        return fallback.recordRequest(provider);
      }),
    // The budget exists to protect providers, so without Redis it falls back to
    // this instance's own count rather than allowing every retry.
    tryRetry: (provider) =>
      inner.tryRetry(provider).catch((error) => {
        warn(error);
        return fallback.tryRetry(provider);
      }),
  };
}
