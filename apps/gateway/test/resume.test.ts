import {
  type ChatCompletionRequest,
  CONTINUE_PROMPT,
  ProviderError,
  type StreamEvent,
} from "@switchboard/core";
import { describe, expect, it } from "vitest";
import type { ProviderAdapter, ProviderCall } from "../src/providers/types.js";
import { continuationBody, overlapTrimmer } from "../src/resilience/resume.js";
import { chatRequest, FAST_RESILIENCE, sseData, testGateway, testGatewayWith } from "./helpers.js";

const trim = (sent: string, ...pieces: string[]): string => {
  const trimmer = overlapTrimmer(sent);
  return pieces.map((piece) => trimmer.push(piece)).join("") + trimmer.flush();
};

describe("overlapTrimmer", () => {
  it("passes through text that repeats nothing", () => {
    expect(trim("The quick brown", " fox", " jumps")).toBe(" fox jumps");
  });

  it("removes a whole echoed prefix, as Mistral sends", () => {
    expect(trim("The quick brown", "The quick brown fox")).toBe(" fox");
  });

  it("removes an echo split across pieces, without sending any of it", () => {
    const trimmer = overlapTrimmer("The quick brown");
    expect(trimmer.push("The qu")).toBe("");
    expect(trimmer.push("ick br")).toBe("");
    expect(trimmer.push("own fox")).toBe(" fox");
    expect(trimmer.push(" jumps")).toBe(" jumps");
  });

  it("removes a restart of the last few words", () => {
    expect(trim("One sentence. The quick brown", "The quick brown fox")).toBe(" fox");
  });

  it("keeps a short match, which is more likely coincidence", () => {
    expect(trim("I like the", "the end")).toBe("the end");
  });

  it("keeps text that only resembles the answer so far", () => {
    expect(trim("The quick brown fox", "The quick red fox")).toBe("The quick red fox");
  });

  it("releases held text when the stream ends", () => {
    expect(trim("The quick brown fox", "The quick")).toBe("The quick");
  });

  it("returns nothing when the continuation is only an echo", () => {
    expect(trim("The quick brown", "The quick brown")).toBe("");
  });

  it("handles a repeated phrase in the answer so far", () => {
    expect(trim("again and again and", "again and more")).toBe(" more");
  });
});

describe("continuationBody", () => {
  const body: ChatCompletionRequest = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  };

  it("marks an assistant prefix for providers that support it", () => {
    expect(continuationBody(body, "par", "prefix").messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "par", prefix: true },
    ]);
  });

  it("asks everyone else in a follow-up message", () => {
    expect(continuationBody(body, "par", "prompt").messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "par" },
      { role: "user", content: CONTINUE_PROMPT },
    ]);
  });

  it("takes what was already sent off the client's token limit", () => {
    const limited = { ...body, max_tokens: 100, max_completion_tokens: 50 };
    const next = continuationBody(limited, "x".repeat(80), "prompt");
    expect(next.max_tokens).toBe(80);
    expect(next.max_completion_tokens).toBe(30);
    expect(continuationBody(limited, "x".repeat(4000), "prompt").max_tokens).toBe(1);
  });

  it("does not invent a limit, or change the original request", () => {
    expect(continuationBody(body, "par", "prompt")).not.toHaveProperty("max_tokens");
    expect(body.messages).toHaveLength(1);
  });
});

interface Parsed {
  text: string;
  roles: number;
  finish: unknown;
  error: { code: string } | undefined;
  done: boolean;
  ids: number;
  record: Record<string, unknown> | undefined;
}

function parse(events: string[]): Parsed {
  const chunks = events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e));
  return {
    text: chunks.map((c) => c.choices?.[0]?.delta.content ?? "").join(""),
    roles: chunks.filter((c) => c.choices?.[0]?.delta.role).length,
    finish: chunks.find((c) => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason,
    error: chunks.find((c) => c.error)?.error,
    done: events.at(-1) === "[DONE]",
    ids: new Set(chunks.filter((c) => c.id).map((c) => c.id)).size,
    record: chunks.find((c) => c.switchboard)?.switchboard,
  };
}

describe("resuming through the gateway and mock provider", () => {
  const app = testGateway();
  const stream = async (
    model: string,
    chaos?: string,
    options: { midStream?: string; body?: Record<string, unknown> } = {},
  ) => {
    const { midStream, body } = options;
    const res = await app.request(
      "/v1/chat/completions",
      chatRequest(
        { model, stream: true, ...body },
        { ...(chaos ? { chaos } : {}), ...(midStream ? { midStream } : {}) },
      ),
    );
    return { res, parsed: parse(await sseData(res)) };
  };
  const uninterrupted = async (model: string) => (await stream(model)).parsed.text;

  it("resumes on the same provider, byte for byte", async () => {
    const expected = await uninterrupted("mock/mock-lorem");
    const { res, parsed } = await stream("mock/mock-lorem", "drop_after=5; fail_attempts=1");
    expect(res.status).toBe(200);
    expect(parsed.text).toBe(expected);
    expect(parsed.done).toBe(true);
    expect(parsed.error).toBeUndefined();
    expect(parsed.roles).toBe(1);
    expect(parsed.ids).toBe(1);
    expect(parsed.finish).toBe("stop");
    expect(parsed.record).toEqual({
      resumed: true,
      resumes: 1,
      provider: "mock",
      model: "mock/mock-lorem",
      attempts: 2,
    });
  });

  it.each([["drop_after=5"], ["malformed_after=5"], ["error_after=5"], ["stall_after=5"]])(
    "recovers from %s",
    async (fault) => {
      const stallApp = testGatewayWith({ ...FAST_RESILIENCE, stallMs: 50 });
      const expected = await uninterrupted("mock/mock-lorem");
      const res = await stallApp.request(
        "/v1/chat/completions",
        chatRequest(
          { model: "mock/mock-lorem", stream: true },
          { chaos: `${fault}; fail_attempts=1` },
        ),
      );
      const parsed = parse(await sseData(res));
      expect(parsed.text).toBe(expected);
      expect(parsed.done).toBe(true);
    },
    15_000,
  );

  it.each([
    ["a partial repeat", "resume_overlap=9"],
    ["a whole echo", "resume_overlap=100000"],
  ])("removes %s from the continuation", async (_name, overlap) => {
    const expected = await uninterrupted("mock/mock-lorem");
    const { parsed } = await stream("mock/mock-lorem", `drop_after=5; fail_attempts=1; ${overlap}`);
    expect(parsed.text).toBe(expected);
  });

  it("makes progress across several failures", async () => {
    const expected = await uninterrupted("mock/mock-lorem");
    const { parsed } = await stream("mock/mock-lorem", "drop_after=5; fail_attempts=2");
    expect(parsed.text).toBe(expected);
    expect(parsed.record?.resumes).toBe(2);
  });

  it("resumes on the fallback provider, using its own style", async () => {
    const expected = await uninterrupted("route/demo");
    const { res, parsed } = await stream("route/demo", "drop_after=5; fail_attempts=3");
    // Headers were sent before the failure, so only the record names the backup.
    expect(res.headers.get("x-switchboard-provider")).toBe("mock");
    expect(parsed.text).toBe(expected);
    expect(parsed.record).toMatchObject({
      provider: "mock-backup",
      model: "mock-backup/mock-lorem",
      attempts: 4,
    });
  });

  it("ends with an in-band error once every attempt is spent", async () => {
    const { parsed } = await stream("mock/mock-lorem", "drop_after=2");
    expect(parsed.done).toBe(false);
    expect(parsed.error?.code).toBe("network");
    expect(parsed.finish).toBeUndefined();
  });

  it("aborts when the request asks for it", async () => {
    const { parsed } = await stream("mock/mock-lorem", "drop_after=5; fail_attempts=1", {
      midStream: "abort",
    });
    expect(parsed.done).toBe(false);
    expect(parsed.error?.code).toBe("network");
    expect(parsed.record).toBeUndefined();
  });

  it("rejects an unknown policy", async () => {
    const res = await app.request(
      "/v1/chat/completions",
      chatRequest({ model: "mock/mock-lorem" }, { midStream: "pray" }),
    );
    expect(res.status).toBe(400);
  });

  it("uses the gateway's default policy", async () => {
    const res = await app.request(
      "/v1/chat/completions",
      chatRequest(
        { model: "mock/mock-lorem", stream: true },
        { chaos: "drop_after=5; fail_attempts=1" },
      ),
    );
    expect(parse(await sseData(res)).done).toBe(true);
  });

  it("does not resume structured output", async () => {
    const { parsed } = await stream("mock/mock-lorem", "drop_after=5; fail_attempts=1", {
      body: { response_format: { type: "json_object" } },
    });
    expect(parsed.error?.code).toBe("network");
    expect(parsed.done).toBe(false);
  });

  it("marks nothing on a stream that never failed", async () => {
    const { parsed } = await stream("mock/mock-lorem");
    expect(parsed.record).toBeUndefined();
  });
});

describe("resuming with scripted adapters", () => {
  const serverError = () => new ProviderError({ provider: "s", kind: "server", message: "boom" });

  function scripted(
    ...attempts: Array<(call: ProviderCall) => AsyncGenerator<StreamEvent>>
  ): ProviderAdapter & { calls: ProviderCall[] } {
    const calls: ProviderCall[] = [];
    return {
      name: "s",
      models: ["m"],
      resumeStyle: "prompt",
      calls,
      stream(call) {
        calls.push(call);
        const attempt = attempts[calls.length - 1];
        if (!attempt) throw new Error("no script");
        return attempt(call);
      },
    };
  }

  const request = (adapter: ProviderAdapter, body: Record<string, unknown> = {}) =>
    testGateway(adapter).request(
      "/v1/chat/completions",
      chatRequest({ model: "s/m", stream: true, ...body }),
    );

  it("never resumes once a tool call has been sent", async () => {
    const adapter = scripted(async function* () {
      yield { type: "start", upstreamId: "u", model: "m" };
      yield { type: "delta", toolCalls: [{ index: 0, id: "c", function: { name: "f" } }] };
      throw serverError();
    });
    const parsed = parse(await sseData(await request(adapter)));
    expect(parsed.error?.code).toBe("server");
    expect(adapter.calls).toHaveLength(1);
  });

  it("does not resume a request that is itself wrong", async () => {
    const adapter = scripted(async function* () {
      yield { type: "start", upstreamId: "u", model: "m" };
      yield { type: "delta", content: "par" };
      throw new ProviderError({ provider: "s", kind: "bad_request", message: "no" });
    });
    const parsed = parse(await sseData(await request(adapter)));
    expect(parsed.error?.code).toBe("bad_request");
    expect(adapter.calls).toHaveLength(1);
  });

  it("treats a failure after the finish as a complete answer", async () => {
    const adapter = scripted(async function* () {
      yield { type: "start", upstreamId: "u", model: "m" };
      yield { type: "delta", content: "whole" };
      yield { type: "finish", reason: "stop" };
      throw serverError();
    });
    const parsed = parse(await sseData(await request(adapter)));
    expect(parsed.text).toBe("whole");
    expect(parsed.done).toBe(true);
    expect(parsed.error).toBeUndefined();
    expect(adapter.calls).toHaveLength(1);
  });

  it("does not let a stream that ends without finishing look complete", async () => {
    const adapter = scripted(
      async function* () {
        yield { type: "start", upstreamId: "u", model: "m" };
        yield { type: "delta", content: "par" };
      },
      async function* () {
        yield { type: "start", upstreamId: "u", model: "m" };
        yield { type: "delta", content: "tial" };
        yield { type: "finish", reason: "stop" };
      },
    );
    const parsed = parse(await sseData(await request(adapter)));
    expect(parsed.text).toBe("partial");
    expect(parsed.done).toBe(true);
  });

  it("carries the partial answer and reduced limit to the next attempt", async () => {
    const adapter = scripted(
      async function* () {
        yield { type: "start", upstreamId: "u", model: "m" };
        yield { type: "delta", content: "12345678" };
        throw serverError();
      },
      async function* () {
        yield { type: "start", upstreamId: "u", model: "m" };
        yield { type: "delta", content: "9" };
        yield { type: "finish", reason: "stop" };
      },
    );
    const parsed = parse(await sseData(await request(adapter, { max_tokens: 10 })));
    expect(parsed.text).toBe("123456789");
    expect(adapter.calls[1]?.body.max_tokens).toBe(8);
    expect(adapter.calls[1]?.body.messages.at(-2)).toEqual({
      role: "assistant",
      content: "12345678",
    });
  });

  it("stops the failed attempt's upstream call, and the live one when the client leaves", async () => {
    const adapter = scripted(
      async function* () {
        yield { type: "start", upstreamId: "u", model: "m" };
        yield { type: "delta", content: "par" };
        throw serverError();
      },
      async function* ({ signal }) {
        yield { type: "start", upstreamId: "u", model: "m" };
        yield { type: "delta", content: "tial" };
        while (!signal.aborted) {
          yield { type: "delta", content: "." };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    );
    const res = await request(adapter);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (let i = 0; i < 4; i++) await reader.read();
    await reader.cancel();
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]?.signal.aborted).toBe(true);
    expect(adapter.calls[1]?.signal.aborted).toBe(true);
  });
});
