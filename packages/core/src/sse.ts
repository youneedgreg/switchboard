/**
 * Server-Sent Events parsing and encoding.
 *
 * The parser follows the WHATWG event-stream rules closely enough for LLM
 * providers: CRLF / LF / CR line endings, multi-line `data:` fields, comments,
 * and chunk boundaries that fall anywhere (including between `\r` and `\n`).
 */

export interface SseMessage {
  event?: string;
  id?: string;
  data: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  const takeLines = (text: string): string[] => {
    // A trailing "\r" may be the first half of a "\r\n" split across chunks,
    // so hold it back until the next chunk arrives.
    let hold = "";
    let rest = text;
    if (rest.endsWith("\r")) {
      hold = "\r";
      rest = rest.slice(0, -1);
    }
    const lines = rest.split(/\r\n|\r|\n/);
    buffer = (lines.pop() ?? "") + hold;
    return lines;
  };

  function* processLine(line: string): Generator<SseMessage> {
    if (line === "") {
      if (data.length > 0) {
        const message: SseMessage = { data: data.join("\n") };
        if (event !== undefined) message.event = event;
        if (id !== undefined) message.id = id;
        yield message;
      }
      data = [];
      event = undefined;
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }

  for await (const chunk of body) {
    for (const line of takeLines(buffer + decoder.decode(chunk, { stream: true }))) {
      yield* processLine(line);
    }
  }

  // Per the spec, an event without a terminating blank line is discarded.
  for (const line of takeLines(buffer + decoder.decode())) {
    yield* processLine(line);
  }
}

export function encodeSse(data: string, event?: string): string {
  const head = event ? `event: ${event}\n` : "";
  const body = data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return `${head}${body}\n\n`;
}
