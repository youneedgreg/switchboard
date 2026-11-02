/**
 * The attempt loop: runs a request down a chain of providers until one attempt
 * reaches the commit point, retrying or falling back from the failures before it.
 *
 * Nothing reaches the client before the commit point, so every failure up to
 * there is invisible. Streaming requests commit at the first content or
 * tool-call token. Non-streaming requests commit when the attempt completes,
 * because the client sees nothing until the whole response is ready.
 *
 * After the commit point a failure can no longer be hidden, but under the
 * `resume` policy the answer can still be completed on a later attempt.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ChatCompletionRequest,
  ProviderError,
  type ProviderErrorKind,
  type StreamEvent,
} from "@switchboard/core";
import type { ProviderAdapter } from "../providers/types.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { withDeadlines } from "./deadlines.js";
import { type MidStreamPolicy, type ResilienceConfig, retryDelayMs } from "./policy.js";
import { canResumeRequest, continuationBody, overlapTrimmer } from "./resume.js";
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
  midStream: MidStreamPolicy;
  config: ResilienceConfig;
  budget: RetryBudget;
  circuit: CircuitBreaker;
  /** Told about each attempt as it starts, numbered across the whole chain. */
  onAttempt?: (attempt: number, target: AttemptTarget) => void;
}

/**
 * With a fallback ready, these are not worth retrying: a rate-limited provider
 * will refuse again, and waiting on a slow one spends the request's deadline.
 */
const MOVE_ON_AT_ONCE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limited", "timeout"]);

/**
 * Resolves with the events of the committed attempt, starting from its first.
 * Rejects with the last `ProviderError` once no attempts are left, or with the
 * abort reason if the client disconnects. Failures past the commit point are
 * thrown from the returned iterator once they can't be resumed.
 */
export async function runAttempts(request: AttemptRequest): Promise<AsyncIterator<StreamEvent>> {
  const chain = attemptChain(request);
  const committed = await chain.open(() => request.body);
  return request.commitOn === "first-token"
    ? resumingStream(request, chain, committed)
    : committed.events;
}

interface CommittedAttempt {
  events: AsyncIterator<StreamEvent>;
  target: AttemptTarget;
  attempt: number;
  abort: (reason: unknown) => void;
}

/** The position in the chain, shared by every attempt a request makes. */
function attemptChain(request: AttemptRequest) {
  const { targets, headers, signal, commitOn, config, budget, circuit } = request;
  const requestDeadline = Date.now() + config.totalMs;
  let index = 0;
  let tries = 1;
  let attempt = 0;
  let recordedIndex = -1;

  const current = (): AttemptTarget => {
    const target = targets[index];
    if (!target) throw new Error("runAttempts needs at least one target");
    return target;
  };

  /** Moves on to the next attempt, or rethrows if there is none. */
  const advance = async (error: unknown): Promise<void> => {
    if (signal.aborted || !(error instanceof ProviderError)) throw error;
    const { adapter } = current();
    // A request that is itself wrong says nothing bad about the provider.
    if (error.fallbackable) await circuit.record(adapter.name, "failure");
    else ignoreFailure(circuit.record(adapter.name, "success"));

    const remainingMs = requestDeadline - Date.now();
    if (remainingMs <= 0 || !error.fallbackable) throw error;

    const hasFallback = index < targets.length - 1;
    const delay =
      hasFallback && MOVE_ON_AT_ONCE.has(error.kind)
        ? undefined
        : retryDelayMs(error, tries, remainingMs, config);
    if (delay !== undefined && (await budget.tryRetry(adapter.name))) {
      await sleep(delay, undefined, { signal });
      tries++;
    } else if (hasFallback) {
      index++;
      tries = 1;
    } else {
      throw error;
    }
  };

  /** Runs attempts until one reaches the commit point. */
  const open = async (
    bodyFor: (target: AttemptTarget) => ChatCompletionRequest,
  ): Promise<CommittedAttempt> => {
    for (;;) {
      signal.throwIfAborted();
      const target = current();
      const { adapter, upstreamModel } = target;

      const decision = await circuit.allow(adapter.name);
      if (!decision.allowed) {
        if (index === targets.length - 1) {
          throw new ProviderError({
            provider: adapter.name,
            kind: "circuit_open",
            message: `${adapter.name} is failing, so it was not called`,
            retryAfterMs: decision.retryAfterMs,
          });
        }
        index++;
        tries = 1;
        continue;
      }

      if (recordedIndex !== index) {
        recordedIndex = index;
        ignoreFailure(budget.recordRequest(adapter.name));
      }
      attempt++;
      request.onAttempt?.(attempt, target);
      const attemptAbort = new AbortController();
      const events = withDeadlines(
        adapter.stream({
          model: upstreamModel,
          body: bodyFor(target),
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
        const committed = await untilCommitted(events, adapter.name, commitOn);
        ignoreFailure(circuit.record(adapter.name, "success"));
        return {
          events: committed,
          target,
          attempt,
          abort: (reason) => attemptAbort.abort(reason),
        };
      } catch (error) {
        attemptAbort.abort(error);
        await advance(error);
      }
    }
  };

  return { open, advance };
}

/** For bookkeeping not worth holding the response up for. */
function ignoreFailure(work: Promise<unknown>): void {
  work.catch(() => {});
}

/**
 * The client's view of a streaming request once committed: one coherent answer,
 * however many attempts it takes to produce.
 *
 * A plain iterator, for the same reason as `withDeadlines`: the client leaving
 * must not have to wait for a read to settle.
 */
function resumingStream(
  { body, midStream, signal }: AttemptRequest,
  chain: ReturnType<typeof attemptChain>,
  first: CommittedAttempt,
): AsyncIterator<StreamEvent> {
  let current = first;
  let trimmer: ReturnType<typeof overlapTrimmer> | undefined;
  let sent = "";
  let sentToolCalls = false;
  let finished = false;
  const queue: StreamEvent[] = [];

  // Half a tool call's arguments cannot be continued.
  const canResume = () =>
    midStream === "resume" && sent !== "" && !sentToolCalls && canResumeRequest(body);

  const readEvent = async (): Promise<IteratorResult<StreamEvent>> => {
    const result = await current.events.next();
    if (result.done && !finished) {
      const provider = current.target.adapter.name;
      throw new ProviderError({
        provider,
        kind: "protocol",
        message: `${provider} stream ended before a finish_reason`,
      });
    }
    return result;
  };

  const accept = (event: StreamEvent): void => {
    switch (event.type) {
      case "start":
        // The client has its role chunk from the first attempt.
        if (!trimmer) queue.push(event);
        return;
      case "delta": {
        if (event.toolCalls) sentToolCalls = true;
        let content = event.content;
        if (content !== undefined && trimmer) {
          content = trimmer.push(content);
          if (event.toolCalls) content += trimmer.flush();
        }
        if (content) sent += content;
        if (content || event.toolCalls) queue.push({ ...event, content: content || undefined });
        return;
      }
      case "finish": {
        finished = true;
        const rest = trimmer?.flush();
        if (rest) {
          sent += rest;
          queue.push({ type: "delta", content: rest });
        }
        queue.push(event);
        return;
      }
      default:
        queue.push(event);
    }
  };

  return {
    async next() {
      for (;;) {
        const queued = queue.shift();
        if (queued) return { done: false, value: queued };

        let result: IteratorResult<StreamEvent>;
        try {
          result = await readEvent();
        } catch (error) {
          current.abort(error);
          // The answer is complete; only the trailing usage or [DONE] was lost.
          if (finished) return { done: true, value: undefined };
          if (signal.aborted || !canResume()) throw error;

          await chain.advance(error);
          const partial = sent;
          current = await chain.open(({ adapter }) =>
            continuationBody(body, partial, adapter.resumeStyle),
          );
          trimmer = overlapTrimmer(partial);
          const { adapter, upstreamModel } = current.target;
          queue.push({
            type: "resume",
            provider: adapter.name,
            model: `${adapter.name}/${upstreamModel}`,
            attempt: current.attempt,
          });
          continue;
        }
        if (result.done) return result;
        accept(result.value);
      }
    },
    return(value?: unknown) {
      return current.events.return?.(value) ?? Promise.resolve({ done: true, value: undefined });
    },
  };
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
