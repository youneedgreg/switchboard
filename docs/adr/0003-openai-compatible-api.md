# 0003. OpenAI-compatible API, streaming upstream always

- Status: Accepted
- Date: 2026-10-11

## Context and problem

What API should clients use to reach the gateway, and how should the gateway talk to providers?

## Options considered

**Client-facing API**
1. A custom Switchboard API. Full freedom, but every user needs a new client library.
2. **The OpenAI Chat Completions format.** The de facto standard: official and community SDKs
   in every language accept a custom `baseURL`, and most providers (Mistral, Groq, Together,
   Ollama, vLLM) already speak it.

**Provider-facing calls**
1. Mirror the client: stream upstream only when the client streams.
2. **Always stream upstream**, and aggregate in the gateway when the client wants one JSON
   object.

## Decision

The gateway exposes the OpenAI Chat Completions API, with models named `provider/model`, and
always streams upstream.

## Consequences

- Any OpenAI SDK works by changing `baseURL` and the API key. This is enforced by a test suite
  that runs the official `openai` package against a real gateway.
- One request path. Retries, fallbacks, mid-stream recovery, time-to-first-token measurement and
  usage accounting are written once, for streams, and non-streaming requests get them for free.
- Non-streaming responses must be rebuilt from deltas, including tool calls, which arrive as
  fragments keyed by index.
- The gateway issues its own response ids and echoes the client's model name, so a response
  stays consistent even when a fallback changes the upstream provider mid-request.
- Error responses use OpenAI's `{"error": {...}}` shape and statuses, so SDKs raise their normal
  exception types (`RateLimitError`, `APIError`).
- Features outside the OpenAI format (for example Mistral's `prefix` continuation) stay internal
  to adapters.
