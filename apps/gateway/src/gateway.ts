import { ChatCompletionRequest, ProviderError, type StreamEvent } from "@switchboard/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { aggregate, prime, sseBody } from "./chat/response.js";
import { bearerAuth } from "./http/auth.js";
import { openAIError, providerErrorResponse } from "./http/errors.js";
import { type ProviderRegistry, resolveModel } from "./providers/registry.js";

export interface GatewayOptions {
  apiKeys: readonly string[];
  registry: ProviderRegistry;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
};

export function createGateway({ apiKeys, registry }: GatewayOptions): Hono {
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
      data: [...registry.values()].flatMap((adapter) =>
        adapter.models.map((model) => ({
          id: `${adapter.name}/${model}`,
          object: "model",
          created: 0,
          owned_by: adapter.name,
        })),
      ),
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

    const resolved = resolveModel(registry, body.model);
    if (!resolved) {
      return c.json(
        openAIError(
          `Unknown model "${body.model}". Models are named "provider/model"; see GET /v1/models.`,
          "invalid_request_error",
          "model_not_found",
        ),
        404,
      );
    }

    // One controller for the upstream call, aborted if the client disconnects.
    const upstream = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => upstream.abort(c.req.raw.signal.reason), {
      once: true,
    });

    let events: AsyncIterator<StreamEvent>;
    try {
      events = await prime(
        resolved.adapter.stream({
          model: resolved.upstreamModel,
          body,
          headers: c.req.raw.headers,
          signal: upstream.signal,
        }),
      );
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const { status, body: errorBody, headers } = providerErrorResponse(error);
      return c.json(errorBody, status, headers);
    }

    const requestId = crypto.randomUUID();
    const meta = {
      id: `chatcmpl-${requestId}`,
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    const headers = { "x-request-id": requestId, "x-switchboard-provider": resolved.adapter.name };

    if (!body.stream) {
      try {
        return c.json(await aggregate(events, meta), 200, headers);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        const { status, body: errorBody } = providerErrorResponse(error);
        return c.json(errorBody, status, headers);
      }
    }

    const includeUsage = body.stream_options?.include_usage === true;
    return new Response(
      sseBody(events, { ...meta, includeUsage }, (reason) => upstream.abort(reason)),
      { headers: { ...SSE_HEADERS, ...headers } },
    );
  });

  return app;
}
