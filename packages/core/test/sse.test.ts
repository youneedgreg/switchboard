import { describe, expect, it } from "vitest";
import { encodeSse, parseSse, type SseMessage } from "../src/sse.js";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const message of parseSse(stream)) out.push(message);
  return out;
}

describe("parseSse", () => {
  it("parses OpenAI-style data events", async () => {
    const messages = await collect(streamOf('data: {"a":1}\n\n', "data: [DONE]\n\n"));
    expect(messages).toEqual([{ data: '{"a":1}' }, { data: "[DONE]" }]);
  });

  it("joins multi-line data and keeps event and id fields", async () => {
    const messages = await collect(streamOf("event: note\nid: 7\ndata: one\ndata: two\n\n"));
    expect(messages).toEqual([{ event: "note", id: "7", data: "one\ntwo" }]);
  });

  it("handles every line ending, including CRLF split across chunks", async () => {
    const messages = await collect(streamOf("data: a\r", "\n\r", "\ndata: b\r\rdata: c\n\n"));
    expect(messages).toEqual([{ data: "a" }, { data: "b" }, { data: "c" }]);
  });

  it("handles events split at arbitrary byte boundaries", async () => {
    const text = 'data: {"content":"héllo"}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(text);
    // Feed one byte at a time, splitting the multi-byte "é" too.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual([{ data: '{"content":"héllo"}' }, { data: "[DONE]" }]);
  });

  it("ignores comments and blank events", async () => {
    const messages = await collect(streamOf(": keep-alive\n\n\n\ndata: x\n\n"));
    expect(messages).toEqual([{ data: "x" }]);
  });

  it("discards an event that is not terminated by a blank line", async () => {
    const messages = await collect(streamOf("data: complete\n\ndata: partial"));
    expect(messages).toEqual([{ data: "complete" }]);
  });

  it("round-trips through encodeSse", async () => {
    const messages = await collect(streamOf(encodeSse("line1\nline2", "custom")));
    expect(messages).toEqual([{ event: "custom", data: "line1\nline2" }]);
  });
});
