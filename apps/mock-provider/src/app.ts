/**
 * An OpenAI-compatible chat completions server that can fail on command.
 * See ./chaos.ts for the fault-injection switches.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ChatCompletion,
  type ChatCompletionChunk,
  ChatCompletionRequest,
  type ChatMessage,
  encodeSse,
  type OpenAIErrorBody,
  type Usage,
} from "@switchboard/core";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CHAOS_HEADER, type Chaos, ChaosParseError, failureStatus, parseChaos } from "./chaos.js";
import { estimateTokens, generateTokens, MOCK_MODELS, type MockModel, mulberry32 } from "./text.js";

function errorBody(message: string, type: string, code: string | null = null): OpenAIErrorBody {
  return { error: { message, type, code } };
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (typeof part.text === "string" ? part.text : "")).join(" ");
}

function isMockModel(model: string): model is MockModel {
  return (MOCK_MODELS as readonly string[]).includes(model);
}

export function createMockApp(): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: MOCK_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "mock" })),
    }),
  );

  app.post("/v1/chat/completions", async (c) => {
    let chaos: Chaos;
    try {
      chaos = parseChaos(c.req.header(CHAOS_HEADER));
    } catch (error) {
      if (error instanceof ChaosParseError) {
        return c.json(errorBody(error.message, "invalid_request_error", "invalid_chaos"), 400);
      }
      throw error;
    }

    const parsed = ChatCompletionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(errorBody(parsed.error.message, "invalid_request_error"), 400);
    }
    const request = parsed.data;
    if (!isMockModel(request.model)) {
      return c.json(
        errorBody(`Unknown model "${request.model}"`, "invalid_request_error", "model_not_found"),
        404,
      );
    }

    const random = mulberry32(chaos.seed ?? Math.floor(Math.random() * 2 ** 32));
    const status = failureStatus(chaos, random);
    if (status !== undefined) {
      const headers: Record<string, string> = {};
      if (chaos.retry_after !== undefined) headers["retry-after"] = String(chaos.retry_after);
      return c.json(
        errorBody(
          `chaos: injected ${status}`,
          status === 429 ? "rate_limit_error" : "server_error",
        ),
        status as ContentfulStatusCode,
        headers,
      );
    }

    const lastUser = request.messages.findLast((m) => m.role === "user");
    const tokens = generateTokens(request.model, lastUser ? textOf(lastUser) : "", {
      count: chaos.tokens,
      seed: chaos.seed,
    });
    const promptTokens = estimateTokens(request.messages.map(textOf).join("\n"));
    const usage: Usage = {
      prompt_tokens: promptTokens,
      completion_tokens: tokens.length,
      total_tokens: promptTokens + tokens.length,
    };
    const meta = {
      id: `mock-${crypto.randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: request.model,
    };
    const signal = c.req.raw.signal;

    if (!request.stream) {
      await sleep(chaos.ttft_ms + chaos.token_ms * tokens.length, undefined, { signal });
      const completion: ChatCompletion = {
        ...meta,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: tokens.join("") },
            finish_reason: "stop",
          },
        ],
        usage,
      };
      return c.json(completion);
    }

    const body = toByteStream(streamChunks(meta, tokens, usage, chaos, signal));
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  });

  return app;
}

async function* streamChunks(
  meta: { id: string; created: number; model: string },
  tokens: string[],
  usage: Usage,
  chaos: Chaos,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const chunk = (
    delta: ChatCompletionChunk["choices"][number]["delta"],
    finish: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
    chunkUsage?: Usage,
  ) => {
    const payload: ChatCompletionChunk = {
      ...meta,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    // Like Mistral, usage rides on the final chunk.
    if (chunkUsage) payload.usage = chunkUsage;
    return encodeSse(JSON.stringify(payload));
  };

  if (chaos.ttft_ms > 0) await sleep(chaos.ttft_ms, undefined, { signal });
  yield chunk({ role: "assistant", content: "" });

  for (let i = 0; i <= tokens.length; i++) {
    if (i === chaos.drop_after) {
      // Let already-sent chunks leave the socket buffer first, so that
      // drop_after=N delivers exactly N tokens before the cut.
      await sleep(25, undefined, { signal });
      throw new Error("chaos: connection dropped");
    }
    if (i === chaos.stall_after) {
      // Hold the connection open, sending nothing, until the caller gives up.
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (i === chaos.malformed_after) yield 'data: {"choices": [\n\n';
    if (i === chaos.error_after) {
      yield encodeSse(
        JSON.stringify(errorBody("chaos: upstream error mid-stream", "server_error")),
      );
      return;
    }
    if (i === tokens.length) break;

    if (i > 0 && chaos.token_ms > 0) await sleep(chaos.token_ms, undefined, { signal });
    yield chunk({ content: tokens[i] });
  }

  yield chunk({}, "stop", usage);
  yield "data: [DONE]\n\n";
}

function toByteStream(source: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await source.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await source.return(undefined);
    },
  });
}
