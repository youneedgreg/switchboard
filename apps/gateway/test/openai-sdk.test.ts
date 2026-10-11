/**
 * Drop-in compatibility: the official OpenAI SDK, pointed at a real running
 * gateway, must behave exactly as it does against OpenAI.
 */
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_KEY, testGateway } from "./helpers.js";

let server: ServerType;
let client: OpenAI;

beforeAll(async () => {
  server = serve({ fetch: testGateway().fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  client = new OpenAI({ apiKey: TEST_KEY, baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
});

afterAll(() => {
  server.close();
});

const messages = [{ role: "user" as const, content: "compatible with the sdk" }];

describe("OpenAI SDK compatibility", () => {
  it("lists models", async () => {
    const ids: string[] = [];
    for await (const model of client.models.list()) ids.push(model.id);
    expect(ids).toContain("mock/mock-echo");
  });

  it("creates a non-streaming completion", async () => {
    const completion = await client.chat.completions.create({ model: "mock/mock-echo", messages });
    expect(completion.choices[0]?.message.content).toBe("compatible with the sdk");
    expect(completion.usage?.total_tokens).toBeGreaterThan(0);
  });

  it("streams a completion with a usage chunk", async () => {
    const stream = await client.chat.completions.create({
      model: "mock/mock-echo",
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let completionTokens = 0;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? "";
      if (chunk.usage) completionTokens = chunk.usage.completion_tokens;
    }
    expect(text).toBe("compatible with the sdk");
    expect(completionTokens).toBe(4);
  });

  it("surfaces an upstream 429 as RateLimitError", async () => {
    await expect(
      client.chat.completions.create(
        { model: "mock/mock-lorem", messages },
        { headers: { "x-mock-chaos": "status=429" } },
      ),
    ).rejects.toBeInstanceOf(OpenAI.RateLimitError);
  });

  it("surfaces a mid-stream failure as an APIError while iterating", async () => {
    const stream = await client.chat.completions.create(
      { model: "mock/mock-lorem", messages, stream: true },
      { headers: { "x-mock-chaos": "drop_after=3" } },
    );
    const consume = async () => {
      for await (const _chunk of stream) {
        // drain
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(OpenAI.APIError);
  });

  it("lets the client abort a stalled stream", async () => {
    const controller = new AbortController();
    const stream = await client.chat.completions.create(
      { model: "mock/mock-lorem", messages, stream: true },
      { headers: { "x-mock-chaos": "stall_after=2" }, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    let chunks = 0;
    // The SDK ends iteration quietly on a caller abort rather than throwing.
    for await (const _chunk of stream) chunks++;
    expect(chunks).toBe(3); // role chunk + 2 tokens, then the stall
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
