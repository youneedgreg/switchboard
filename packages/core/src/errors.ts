/**
 * Upstream failures, classified so the gateway can decide what to do next.
 */

export type ProviderErrorKind =
  | "rate_limited" // 429
  | "server" // 5xx or an error object inside the stream
  | "timeout" // no response / no first token in time
  | "network" // connection refused, reset, or stream cut off
  | "protocol" // malformed SSE / JSON, stream ended without finishing
  | "bad_request" // 400, 404, 413, 422: the request itself is wrong
  | "auth"; // 401, 403: our provider credentials are wrong

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limited",
  "server",
  "timeout",
  "network",
  "protocol",
]);

export interface ProviderErrorInit {
  provider: string;
  kind: ProviderErrorKind;
  message: string;
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(init: ProviderErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "ProviderError";
    this.provider = init.provider;
    this.kind = init.kind;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** Whether trying again (same or another provider) could succeed. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  static fromStatus(provider: string, status: number, headers: Headers, detail: string) {
    return new ProviderError({
      provider,
      kind: kindForStatus(status),
      status,
      message: `${provider} responded ${status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
      retryAfterMs: parseRetryAfter(headers.get("retry-after")),
    });
  }
}

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status >= 500) return "server";
  return "bad_request";
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
