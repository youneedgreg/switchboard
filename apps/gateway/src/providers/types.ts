import type { ChatCompletionRequest, StreamEvent } from "@switchboard/core";

export interface ProviderCall {
  /** Upstream model id, without the "provider/" prefix. */
  model: string;
  body: ChatCompletionRequest;
  /** The client's request headers; adapters choose which, if any, to forward. */
  headers: Headers;
  signal: AbortSignal;
}

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
  stream(call: ProviderCall): AsyncIterable<StreamEvent>;
}
