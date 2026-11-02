/**
 * The attempt loop: runs a request down a chain of providers until one attempt
 * reaches the commit point, retrying or falling back from the failures before it.
 *
 * Nothing reaches the client before the commit point, so every failure up to
 * there is invisible. Streaming requests commit at the first content or
 * tool-call token. Non-streaming requests commit when the attempt completes,
 * because the client sees nothing until the whole response is ready.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ChatCompletionRequest,
  ProviderError,
  type ProviderErrorKind,
  type StreamEvent,
} from "@switchboard/core";
import type { ProviderAdapter } from "../providers/types.js";
import { withDeadlines } from "./deadlines.js";
import { type ResilienceConfig, retryDelayMs } from "./policy.js";
import type { RetryBudget } from "./retry-budget.js";

export interface AttemptTarget {
  adapter: ProviderAdapter;
  /** Upstream model id, without the "provider/" prefix. */
  upstreamModel: string;
}

export interface AttemptRequest {
  /** Tried in order. A request naming one model has a chain of one. */
  targets: readonly AttemptTarget[];
  body: ChatCompletionRequest;
  headers: Headers;
  /** Fires when the client has gone away. */
  signal: AbortSignal;
  commitOn: "first-token" | "complete";
  config: ResilienceConfig;
  budget: RetryBudget;
  /** Told about each attempt as it starts, numbered across the whole chain. */
  onAttempt?: (attempt: number, target: AttemptTarget) => void;
}

/**
 * With a fallback ready, these are not worth retrying: a rate-limited provider
 * will refuse again, and waiting on a slow one spends the request's deadline.
 */
const MOVE_ON_AT_ONCE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limited", "timeout"]);

/**
 * Resolves with the committed attempt's events, starting from its first event.
 * Rejects with the last `ProviderError` once no attempts are left, or with the
 * abort reason if the client disconnects.
 */
export async function runAttempts(request: AttemptRequest): Promise<AsyncIterator<StreamEvent>> {
  const { targets, body, headers, signal, commitOn, config, budget } = request;
  const requestDeadline = Date.now() + config.totalMs;
  let attempt = 0;

  for (const [index, target] of targets.entries()) {
    const { adapter, upstreamModel } = target;
    const hasFallback = index < targets.length - 1;
    await budget.recordRequest(adapter.name);

    for (let tries = 1; ; tries++) {
      signal.throwIfAborted();
      attempt++;
      request.onAttempt?.(attempt, target);
      const attemptAbort = new AbortController();
      const events = withDeadlines(
        adapter.stream({
          model: upstreamModel,
          body,
          headers,
          attempt,
          signal: AbortSignal.any([signal, attemptAbort.signal]),
        }),
        {
          provider: adapter.name,
          firstTokenMs: config.firstTokenMs,
          stallMs: config.stallMs,
          requestDeadline,
          abort: (reason) => attemptAbort.abort(reason),
        },
      );

      try {
        return await untilCommitted(events, adapter.name, commitOn);
      } catch (error) {
        attemptAbort.abort(error);
        if (signal.aborted || !(error instanceof ProviderError)) throw error;

        const remainingMs = requestDeadline - Date.now();
        if (remainingMs <= 0 || !error.fallbackable) throw error;

        const delay =
          hasFallback && MOVE_ON_AT_ONCE.has(error.kind)
            ? undefined
            : retryDelayMs(error, tries, remainingMs, config);
        if (delay !== undefined && (await budget.tryRetry(adapter.name))) {
          await sleep(delay, undefined, { signal });
          continue;
        }
        if (hasFallback) break;
        throw error;
      }
    }
  }

  throw new Error("runAttempts needs at least one target");
}

/** Holds events back until the commit point, then replays them. */
async function untilCommitted(
  events: AsyncIterator<StreamEvent>,
  provider: string,
  commitOn: AttemptRequest["commitOn"],
): Promise<AsyncIterator<StreamEvent>> {
  const held: StreamEvent[] = [];
  for (;;) {
    const result = await events.next();
    if (result.done) break;
    held.push(result.value);
    const { type } = result.value;
    if (commitOn === "first-token" && (type === "delta" || type === "finish")) {
      return replay(held, events);
    }
  }
  if (!held.some((event) => event.type === "finish")) {
    throw new ProviderError({
      provider,
      kind: "protocol",
      message: `${provider} stream ended before a finish_reason`,
    });
  }
  return replay(held, events);
}

function replay(
  held: readonly StreamEvent[],
  rest: AsyncIterator<StreamEvent>,
): AsyncIterator<StreamEvent> {
  let index = 0;
  return {
    next() {
      const value = held[index];
      if (value === undefined) return rest.next();
      index++;
      return Promise.resolve({ done: false, value });
    },
    return(value?: unknown) {
      return rest.return?.(value) ?? Promise.resolve({ done: true, value: undefined });
    },
  };
}
