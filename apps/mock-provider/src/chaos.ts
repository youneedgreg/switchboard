/**
 * Fault injection for the mock provider.
 *
 * Chaos is requested per call with a header such as:
 *   x-mock-chaos: ttft_ms=800; token_ms=20; drop_after=12
 *
 * Token-position faults (drop/stall/malformed/error) fire *before* the token
 * at that index is sent, so `drop_after=0` cuts the stream before any content.
 */
import { z } from "zod";

export const CHAOS_HEADER = "x-mock-chaos";

const ms = z.coerce.number().int().min(0).max(120_000);
const position = z.coerce.number().int().min(0).max(100_000);

export const Chaos = z.strictObject({
  /** Respond with this HTTP status instead of streaming. */
  status: z.coerce.number().int().min(400).max(599).optional(),
  /** Retry-After header (seconds) sent with a failing status. */
  retry_after: z.coerce.number().min(0).max(3600).optional(),
  /** Fail with `status` (default 503) on this fraction of requests. */
  fail_rate: z.coerce.number().min(0).max(1).optional(),
  /** Delay before the first chunk. */
  ttft_ms: ms.default(0),
  /** Delay between content chunks. */
  token_ms: ms.default(0),
  /** Override the response length in tokens. */
  tokens: z.coerce.number().int().min(1).max(100_000).optional(),
  /** Abruptly cut the connection before token N. */
  drop_after: position.optional(),
  /** Stop sending (but keep the connection open) before token N. */
  stall_after: position.optional(),
  /** Send an unparseable chunk before token N. */
  malformed_after: position.optional(),
  /** Send an in-stream error object before token N, then end the stream. */
  error_after: position.optional(),
  /** Seed for deterministic output and fail_rate decisions. */
  seed: z.coerce.number().int().optional(),
});
export type Chaos = z.infer<typeof Chaos>;

export class ChaosParseError extends Error {
  override name = "ChaosParseError";
}

export function parseChaos(header: string | null | undefined): Chaos {
  if (!header?.trim()) return Chaos.parse({});

  const entries = header
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) {
        throw new ChaosParseError(`Expected key=value in ${CHAOS_HEADER}, got "${pair}"`);
      }
      return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] as const;
    });

  const result = Chaos.safeParse(Object.fromEntries(entries));
  if (!result.success) throw new ChaosParseError(z.prettifyError(result.error));
  return result.data;
}

/** The status to fail with for this request, or undefined to succeed. */
export function failureStatus(chaos: Chaos, random: () => number): number | undefined {
  if (chaos.fail_rate !== undefined) {
    return random() < chaos.fail_rate ? (chaos.status ?? 503) : undefined;
  }
  return chaos.status;
}
