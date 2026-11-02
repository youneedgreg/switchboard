/**
 * The tunable limits of the attempt loop, and the pure decision of whether and
 * when a failed attempt is tried again.
 */
import type { ProviderError } from "@switchboard/core";

/** What to do when a stream fails after the client has received tokens. */
export const MID_STREAM_POLICIES = ["resume", "abort"] as const;
export type MidStreamPolicy = (typeof MID_STREAM_POLICIES)[number];

export interface ResilienceConfig {
  /** Attempts per request, including the first. */
  maxAttempts: number;
  /** Backoff ceiling doubles from this for each retry. */
  backoffBaseMs: number;
  backoffCapMs: number;
  /** A provider asking us to wait longer than this is not waited for. */
  maxRetryAfterMs: number;
  /** Deadline for an attempt's first content or tool-call token. */
  firstTokenMs: number;
  /** Deadline for the gap between events once output has started. */
  stallMs: number;
  /** Deadline for the whole request, across every attempt and backoff. */
  totalMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceConfig = {
  maxAttempts: 3,
  backoffBaseMs: 200,
  backoffCapMs: 4_000,
  maxRetryAfterMs: 5_000,
  firstTokenMs: 20_000,
  stallMs: 10_000,
  totalMs: 120_000,
};

/**
 * Exponential backoff with full jitter: a uniform pick between zero and the
 * ceiling, so that clients failing together do not retry together.
 */
export function backoffMs(
  attempt: number,
  config: Pick<ResilienceConfig, "backoffBaseMs" | "backoffCapMs">,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** How long to wait before the next attempt, or undefined to stop trying. */
export function retryDelayMs(
  error: ProviderError,
  attempt: number,
  remainingMs: number,
  config: ResilienceConfig,
  random: () => number = Math.random,
): number | undefined {
  if (!error.retryable || attempt >= config.maxAttempts) return undefined;
  const { retryAfterMs } = error;
  if (retryAfterMs !== undefined && retryAfterMs > config.maxRetryAfterMs) return undefined;
  const delay = Math.max(retryAfterMs ?? 0, backoffMs(attempt, config, random));
  return delay < remainingMs ? delay : undefined;
}
