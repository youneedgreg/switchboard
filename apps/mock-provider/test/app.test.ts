import { type ChatCompletion, parseSse } from "@switchboard/core";
import { describe, expect, it } from "vitest";
import { createMockApp } from "../src/app.js";

const app = createMockApp();

function chat(body: Record<string, unknown>, chaos?: string) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(chaos ? { "x-mock-chaos": chaos } : {}) },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello world" }], ...body }),
  });
}

async function readEvents(res: Response): Promise<string[]> {
  const out: string[] = [];
  for await (const message of parseSse(res.body as ReadableStream<Uint8Array>)) {
    out.push(message.data);
  }
  return out;
}

describe("mock provider", () => {
  it("returns a full completion with usage", async () => {
    const res = await chat({ model: "mock-echo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatCompletion;
    expect(body.choices[0]?.message.content).toBe("hello world");
    expect(body.usage?.completion_tokens).toBe(2);
  });

  it("streams role, content, finish+usage, then [DONE]", async () => {
    const res = await chat({ model: "mock-echo", stream: true });
    const events = await readEvents(res);
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    expect(text).toBe("hello world");
    const last = chunks.at(-1);
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage.completion_tokens).toBe(2);
  });

  it("fails with the injected status and Retry-After", async () => {
    const res = await chat({ model: "mock-lorem" }, "status=429; retry_after=3");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3");
  });

  it("drops the connection mid-stream", async () => {
    const res = await chat({ model: "mock-lorem", stream: true }, "drop_after=5");
    expect(res.status).toBe(200);
    const seen: string[] = [];
    await expect(async () => {
      for await (const message of parseSse(res.body as ReadableStream<Uint8Array>)) {
        seen.push(message.data);
      }
    }).rejects.toThrow("chaos: connection dropped");
    // role chunk + 5 content chunks before the drop
    expect(seen).toHaveLength(6);
  });

  it("sends an in-stream error object", async () => {
    const res = await chat({ model: "mock-lorem", stream: true }, "error_after=2");
    const events = await readEvents(res);
    expect(JSON.parse(events.at(-1) as string).error.type).toBe("server_error");
  });

  it("stalls until the caller aborts", async () => {
    const controller = new AbortController();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mock-chaos": "stall_after=1" },
      body: JSON.stringify({
        model: "mock-lorem",
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
      signal: controller.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // role chunk
    await reader.read(); // first token
    setTimeout(() => controller.abort(), 50);
    await expect(reader.read()).rejects.toThrow();
  });

  it("rejects unknown models and bad chaos", async () => {
    expect((await chat({ model: "gpt-9" })).status).toBe(404);
    expect((await chat({ model: "mock-lorem" }, "nope=1")).status).toBe(400);
  });
});
