/**
 * The attempt loop: runs a request against a provider until one attempt reaches
 * the commit point, retrying the failures that came before it.
 *
 * Nothing reaches the client before the commit point, so every failure up to
 * there is invisible. Streaming requests commit at the first content or
 * tool-call token. Non-streaming requests commit when the attempt completes,
 * because the client sees nothing until the whole response is ready.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { type ChatCompletionRequest, ProviderError, type StreamEvent } from "@switchboard/core";
import type { ProviderAdapter } from "../providers/types.js";
import { withDeadlines } from "./deadlines.js";
import { type ResilienceConfig, retryDelayMs } from "./policy.js";
import type { RetryBudget } from "./retry-budget.js";

export interface AttemptRequest {
  adapter: ProviderAdapter;
  upstreamModel: string;
  body: ChatCompletionRequest;
  headers: Headers;
  /** Fires when the client has gone away. */
  signal: AbortSignal;
  commitOn: "first-token" | "complete";
  config: ResilienceConfig;
  budget: RetryBudget;
  /** Told the number of each attempt as it starts. */
  onAttempt?: (attempt: number) => void;
}

/**
 * Resolves with the committed attempt's events, starting from its first event.
 * Rejects with the last `ProviderError` once no attempts are left, or with the
 * abort reason if the client disconnects.
 */
export async function runAttempts(request: AttemptRequest): Promise<AsyncIterator<StreamEvent>> {
  const { adapter, upstreamModel, body, headers, signal, commitOn, config, budget } = request;
  const requestDeadline = Date.now() + config.totalMs;
  await budget.recordRequest(adapter.name);

  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    request.onAttempt?.(attempt);
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

      const delay = retryDelayMs(error, attempt, requestDeadline - Date.now(), config);
      if (delay === undefined || !(await budget.tryRetry(adapter.name))) throw error;
      await sleep(delay, undefined, { signal });
    }
  }
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
