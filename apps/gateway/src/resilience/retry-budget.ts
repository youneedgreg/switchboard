/**
 * Caps retries as a share of recent traffic, so that a struggling provider
 * sees a small bump in load during an outage rather than a multiple of it.
 */
export interface RetryBudget {
  recordRequest(provider: string): Promise<void>;
  /** Claims one retry, or returns false if the budget is spent. */
  tryRetry(provider: string): Promise<boolean>;
}

export interface RetryBudgetConfig {
  /** Retries allowed as a fraction of requests in the window. */
  ratio: number;
  /** Retries always allowed per second, so quiet periods can still retry. */
  minPerSecond: number;
  windowSeconds: number;
}

export const DEFAULT_RETRY_BUDGET: RetryBudgetConfig = {
  ratio: 0.1,
  minPerSecond: 1,
  windowSeconds: 10,
};

interface Bucket {
  second: number;
  requests: number;
  retries: number;
}

/** One instance's view of traffic, in one-second buckets. */
export function inMemoryRetryBudget(
  config: RetryBudgetConfig = DEFAULT_RETRY_BUDGET,
  now: () => number = Date.now,
): RetryBudget {
  const providers = new Map<string, Bucket[]>();

  const current = (provider: string): { live: Bucket[]; bucket: Bucket } => {
    const second = Math.floor(now() / 1000);
    const live = (providers.get(provider) ?? []).filter(
      (bucket) => bucket.second > second - config.windowSeconds,
    );
    providers.set(provider, live);
    let bucket = live.at(-1);
    if (bucket?.second !== second) {
      bucket = { second, requests: 0, retries: 0 };
      live.push(bucket);
    }
    return { live, bucket };
  };

  return {
    async recordRequest(provider) {
      current(provider).bucket.requests++;
    },
    async tryRetry(provider) {
      const { live, bucket } = current(provider);
      const requests = live.reduce((sum, b) => sum + b.requests, 0);
      const retries = live.reduce((sum, b) => sum + b.retries, 0);
      const allowed = config.minPerSecond * config.windowSeconds + config.ratio * requests;
      if (retries >= allowed) return false;
      bucket.retries++;
      return true;
    },
  };
}
