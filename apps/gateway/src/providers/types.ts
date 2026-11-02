import type { ChatCompletionRequest, StreamEvent } from "@switchboard/core";

export interface ProviderCall {
  /** Upstream model id, without the "provider/" prefix. */
  model: string;
  body: ChatCompletionRequest;
  /** The client's request headers; adapters choose which, if any, to forward. */
  headers: Headers;
  /** 1 for the first try at this request. */
  attempt: number;
  signal: AbortSignal;
}

/**
 * How a provider continues a partial answer: from an assistant message marked
 * `prefix`, or by being asked to in a follow-up message.
 */
export type ResumeStyle = "prefix" | "prompt";

/**
 * Every provider is reached through this interface. Adapters always stream
 * upstream, even when the client asked for a single JSON response: the gateway
 * aggregates, so there is exactly one code path to make resilient.
 *
 * Failures are thrown from the iterator as `ProviderError`.
 */
export interface ProviderAdapter {
  readonly name: string;
  /** Models advertised on /v1/models. Others may still work upstream. */
  readonly models: readonly string[];
  readonly resumeStyle: ResumeStyle;
  stream(call: ProviderCall): AsyncIterable<StreamEvent>;
}
