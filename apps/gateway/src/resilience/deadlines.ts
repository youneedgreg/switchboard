import { ProviderError, type StreamEvent } from "@switchboard/core";

export interface AttemptDeadlines {
  provider: string;
  firstTokenMs: number;
  stallMs: number;
  /** Absolute time (ms since the epoch) the whole request must end by. */
  requestDeadline: number;
  /** Stops the upstream call when a deadline passes. */
  abort: (reason: ProviderError) => void;
}

/**
 * Enforces the three deadlines on one attempt's events. The timers race each
 * read rather than relying on the adapter to notice the abort, so a stuck
 * upstream can never hold the request open.
 *
 * Written as a plain iterator: a generator's return() would queue behind a read
 * that may never settle, and could not be used to walk away from one.
 */
export function withDeadlines(
  source: AsyncIterable<StreamEvent>,
  deadlines: AttemptDeadlines,
): AsyncIterator<StreamEvent> {
  const { provider, firstTokenMs, stallMs, requestDeadline, abort } = deadlines;
  const iterator = source[Symbol.asyncIterator]();
  const firstTokenDeadline = Date.now() + firstTokenMs;
  let hasOutput = false;

  return {
    async next() {
      const eventDeadline = hasOutput ? Date.now() + stallMs : firstTokenDeadline;
      const deadline = Math.min(eventDeadline, requestDeadline);
      const message =
        deadline === requestDeadline
          ? `${provider}: request exceeded its total deadline`
          : hasOutput
            ? `${provider} stalled for ${stallMs}ms between tokens`
            : `${provider} sent no token within ${firstTokenMs}ms`;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            const error = new ProviderError({ provider, kind: "timeout", message });
            abort(error);
            reject(error);
          },
          Math.max(0, deadline - Date.now()),
        );
      });

      const read = iterator.next();
      // If the deadline wins, the abandoned read's eventual failure is expected.
      read.catch(() => {});
      try {
        const result = await Promise.race([read, expired]);
        if (!result.done && result.value.type === "delta") hasOutput = true;
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
    async return() {
      iterator.return?.().catch(() => {});
      return { done: true, value: undefined };
    },
  };
}
