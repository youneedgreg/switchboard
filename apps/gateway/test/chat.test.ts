import type { ChatCompletion, StreamEvent } from "@switchboard/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildRegistry } from "../src/providers/registry.js";
import type { ProviderAdapter, ProviderCall } from "../src/providers/types.js";
import { chatRequest, sseData, TEST_KEY, testGateway } from "./helpers.js";

const app = testGateway();
const chat = (body: Record<string, unknown>, chaos?: string) =>
  app.request("/v1/chat/completions", chatRequest(body, chaos ? { chaos } : {}));

describe("auth and routing", () => {
  it("rejects requests without a valid key", async () => {
    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
    const wrong = await app.request("/v1/models", { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("lists models as provider/model", async () => {
    const res = await app.request("/v1/models", {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["mock/mock-lorem", "mock/mock-echo"]);
  });

  it("rejects unknown providers and invalid bodies", async () => {
    expect((await chat({ model: "nobody/model" })).status).toBe(404);
    expect((await chat({ model: "mock-echo" })).status).toBe(404);
    expect((await chat({ model: "mock/mock-echo", messages: [] })).status).toBe(400);
    expect((await chat({ model: "mock/mock-echo", n: 2 })).status).toBe(400);
  });
});

describe("non-streaming", () => {
  it("aggregates the upstream stream into one completion", async () => {
    const res = await chat({ model: "mock/mock-echo" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-switchboard-provider")).toBe("mock");
    const body = (await res.json()) as ChatCompletion;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("mock/mock-echo");
    expect(body.choices[0]?.message.content).toBe("hello gateway");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage?.completion_tokens).toBe(2);
  });
});

describe("streaming", () => {
  it("re-emits OpenAI chunks under the gateway's id and model", async () => {
    const res = await chat({ model: "mock/mock-echo", stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await sseData(res);
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    expect(chunks.every((c) => c.model === "mock/mock-echo")).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe("hello gateway");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    // No usage chunk unless the client asks for one.
    expect(chunks.some((c) => c.usage)).toBe(false);
  });

  it("adds a usage chunk when stream_options.include_usage is set", async () => {
    const res = await chat({
      model: "mock/mock-echo",
      stream: true,
      stream_options: { include_usage: true },
    });
    const events = await sseData(res);
    const usageChunk = JSON.parse(events.at(-2) as string);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
  });
});

describe("upstream failures before any output", () => {
  it("passes 429 through with Retry-After", async () => {
    const res = await chat({ model: "mock/mock-lorem", stream: true }, "status=429; retry_after=7");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("maps upstream 5xx to 502", async () => {
    const res = await chat({ model: "mock/mock-lorem", stream: true }, "status=503");
    expect(res.status).toBe(502);
  });

  it("passes upstream client errors through", async () => {
    const res = await chat({ model: "mock/gpt-9" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("maps a stream that dies before the first token to 502", async () => {
    const res = await chat({ model: "mock/mock-lorem", stream: true }, "drop_after=0");
    // The role chunk arrives first, so this fails after "start": in-band error.
    const events = await sseData(res);
    expect(JSON.parse(events.at(-1) as string).error.code).toBe("network");
  });
});

describe("upstream failures mid-stream", () => {
  it.each([
    ["drop_after=5", "network"],
    ["malformed_after=3", "protocol"],
    ["error_after=3", "server"],
  ])("%s ends the stream with an in-band %s error", async (chaos, code) => {
    const res = await chat({ model: "mock/mock-lorem", stream: true }, chaos);
    expect(res.status).toBe(200);
    const events = await sseData(res);
    expect(events).not.toContain("[DONE]");
    const last = JSON.parse(events.at(-1) as string);
    expect(last.error.code).toBe(code);
  });

  it("returns 502 for a non-streaming request that fails mid-way", async () => {
    const res = await chat({ model: "mock/mock-lorem" }, "drop_after=5");
    expect(res.status).toBe(502);
  });
});

describe("client disconnects", () => {
  it("aborts the upstream call when the client cancels the stream", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const endless: ProviderAdapter = {
      name: "endless",
      models: ["forever"],
      async *stream({ signal }: ProviderCall): AsyncGenerator<StreamEvent> {
        upstreamSignal = signal;
        yield { type: "start", upstreamId: "x", model: "forever" };
        while (!signal.aborted) {
          yield { type: "delta", content: "." };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    };
    const gateway = testGateway(endless);
    const res = await gateway.request(
      "/v1/chat/completions",
      chatRequest({ model: "endless/forever", stream: true }),
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    expect(upstreamSignal?.aborted).toBe(true);
  });
});

describe("tool calls", () => {
  it("stitches streamed tool-call fragments together when aggregating", async () => {
    const tools: ProviderAdapter = {
      name: "tools",
      models: ["t"],
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "start", upstreamId: "x", model: "t" };
        yield {
          type: "delta",
          toolCalls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_", arguments: '{"ci' },
            },
          ],
        };
        yield {
          type: "delta",
          toolCalls: [{ index: 0, function: { name: "weather", arguments: 'ty":"Nairobi"}' } }],
        };
        yield { type: "finish", reason: "tool_calls" };
      },
    };
    const res = await testGateway(tools).request(
      "/v1/chat/completions",
      chatRequest({ model: "tools/t" }),
    );
    const body = (await res.json()) as ChatCompletion;
    expect(body.choices[0]?.message).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Nairobi"}' },
        },
      ],
    });
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
  });
});

describe("Mistral adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("translates OpenAI-only fields and never forwards stream_options", async () => {
    let sent: Record<string, unknown> = {};
    let auth: string | null = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      auth = new Headers(init.headers).get("authorization");
      const chunk = {
        id: "m1",
        model: "mistral-small-latest",
        choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const registry = buildRegistry(
      loadConfig({ GATEWAY_API_KEYS: TEST_KEY, MISTRAL_API_KEY: "mk" }),
    );
    const mistral = registry.get("mistral") as ProviderAdapter;

    const events: StreamEvent[] = [];
    for await (const event of mistral.stream({
      model: "mistral-small-latest",
      body: {
        model: "mistral/mistral-small-latest",
        messages: [{ role: "user", content: "x" }],
        seed: 7,
        max_completion_tokens: 50,
        temperature: null,
        stream_options: { include_usage: true },
      },
      headers: new Headers(),
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(auth).toBe("Bearer mk");
    expect(sent).toEqual({
      model: "mistral-small-latest",
      messages: [{ role: "user", content: "x" }],
      stream: true,
      random_seed: 7,
      max_tokens: 50,
    });
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "finish"]);
  });
});
