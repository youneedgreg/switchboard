/**
 * The provider-neutral event stream every adapter produces.
 *
 * Adapters translate each provider's wire format into these events; the
 * gateway only ever reasons about this shape. Failures are not events: an
 * adapter throws a `ProviderError` from the iterator instead.
 */
import type { FinishReason } from "./openai.js";

export type StreamEvent =
  | { type: "start"; upstreamId: string; model: string }
  | { type: "delta"; content?: string; toolCalls?: unknown[] }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: FinishReason }
  // Added by the gateway, never by an adapter: the answer continues on a new attempt.
  | { type: "resume"; provider: string; model: string; attempt: number };
