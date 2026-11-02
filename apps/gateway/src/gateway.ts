import { ChatCompletionRequest, ProviderError, type StreamEvent } from "@switchboard/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { aggregate, sseBody } from "./chat/response.js";
import { bearerAuth } from "./http/auth.js";
import { openAIError, providerErrorResponse } from "./http/errors.js";
import { type ProviderRegistry, resolveTargets, routeIds } from "./providers/registry.js";
import { type AttemptTarget, runAttempts } from "./resilience/attempts.js";
import { DEFAULT_RESILIENCE, type ResilienceConfig } from "./resilience/policy.js";
import { inMemoryRetryBudget, type RetryBudget } from "./resilience/retry-budget.js";

export interface GatewayOptions {
  apiKeys: readonly string[];
  registry: ProviderRegistry;
  resilience?: ResilienceConfig;
  retryBudget?: RetryBudget;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
};

export function createGateway({
  apiKeys,
  registry,
  resilience = DEFAULT_RESILIENCE,
  retryBudget = inMemoryRetryBudget(),
}: GatewayOptions): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    console.error(error);
    return c.json(openAIError("Internal gateway error", "server_error", null), 500);
  });
  app.notFound((c) => c.json(openAIError("Not found", "invalid_request_error", "not_found"), 404));

  app.get("/", (c) =>
    c.json({ name: "switchboard", docs: "https://github.com/youneedgreg/switchboard" }),
  );
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", bearerAuth(apiKeys));
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          openAIError("Request body exceeds 1 MiB", "invalid_request_error", "too_large"),
          413,
        ),
    }),
  );

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: [
        ...routeIds(registry).map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "switchboard",
        })),
        ...[...registry.values()].flatMap((adapter) =>
          adapter.models.map((model) => ({
            id: `${adapter.name}/${model}`,
            object: "model",
            created: 0,
            owned_by: adapter.name,
          })),
        ),
      ],
    }),
  );

  app.post("/v1/chat/completions", async (c) => {
    const parsed = ChatCompletionRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(
        openAIError(z.prettifyError(parsed.error), "invalid_request_error", "invalid_request"),
        400,
      );
    }
    const body = parsed.data;

    const targets = resolveTargets(registry, body.model);
    const firstTarget = targets[0];
    if (!firstTarget) {
      return c.json(
        openAIError(
          `Unknown model "${body.model}". Models are named "provider/model" or "route/name"; see GET /v1/models.`,
          "invalid_request_error",
          "model_not_found",
        ),
        404,
      );
    }

    // One controller for the request, aborted if the client disconnects.
    const upstream = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => upstream.abort(c.req.raw.signal.reason), {
      once: true,
    });

    const requestId = crypto.randomUUID();
    const meta = {
      id: `chatcmpl-${requestId}`,
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    let attempts = 0;
    let target: AttemptTarget = firstTarget;
    const responseHeaders = () => ({
      "x-request-id": requestId,
      "x-switchboard-provider": target.adapter.name,
      "x-switchboard-model": `${target.adapter.name}/${target.upstreamModel}`,
      "x-switchboard-attempts": String(attempts),
    });

    let events: AsyncIterator<StreamEvent>;
    try {
      events = await runAttempts({
        targets,
        body,
        headers: c.req.raw.headers,
        signal: upstream.signal,
        commitOn: body.stream ? "first-token" : "complete",
        config: resilience,
        budget: retryBudget,
        onAttempt: (attempt, current) => {
          attempts = attempt;
          target = current;
        },
      });
    } catch (error) {
      // Nobody is left to read a response.
      if (upstream.signal.aborted) return new Response(null, { status: 499 });
      if (!(error instanceof ProviderError)) throw error;
      const { status, body: errorBody, headers } = providerErrorResponse(error);
      return c.json(errorBody, status, { ...headers, ...responseHeaders() });
    }

    if (!body.stream) return c.json(await aggregate(events, meta), 200, responseHeaders());

    const includeUsage = body.stream_options?.include_usage === true;
    return new Response(
      sseBody(events, { ...meta, includeUsage }, (reason) => upstream.abort(reason)),
      { headers: { ...SSE_HEADERS, ...responseHeaders() } },
    );
  });

  return app;
}
