import { type OpenAIErrorBody, ProviderError } from "@switchboard/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function openAIError(message: string, type: string, code: string | null): OpenAIErrorBody {
  return { error: { message, type, code } };
}

/**
 * Maps an upstream failure that happened before any output to an HTTP error.
 * The client's request was fine unless upstream says otherwise (bad_request),
 * so most failures surface as gateway errors (502/504), not client errors.
 */
export function providerErrorResponse(error: ProviderError): {
  status: ContentfulStatusCode;
  body: OpenAIErrorBody;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const body = openAIError(error.message, "upstream_error", error.kind);

  switch (error.kind) {
    case "rate_limited":
      if (error.retryAfterMs !== undefined) {
        headers["retry-after"] = String(Math.ceil(error.retryAfterMs / 1000));
      }
      return {
        status: 429,
        body: openAIError(error.message, "rate_limit_error", error.kind),
        headers,
      };
    case "bad_request":
      return {
        status: (error.status ?? 400) as ContentfulStatusCode,
        body: openAIError(error.message, "invalid_request_error", error.kind),
        headers,
      };
    case "timeout":
      return { status: 504, body, headers };
    default:
      return { status: 502, body, headers };
  }
}

/** The error object sent as a final SSE event when a stream fails mid-way. */
export function streamErrorBody(error: unknown): OpenAIErrorBody {
  if (error instanceof ProviderError) {
    return openAIError(error.message, "upstream_error", error.kind);
  }
  return openAIError("Internal gateway error", "server_error", null);
}
