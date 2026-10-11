/**
 * Turns the internal event stream into what the client asked for: OpenAI SSE
 * chunks, or a single aggregated chat.completion object.
 */
import {
  type ChatCompletion,
  type ChatCompletionChunk,
  encodeSse,
  type FinishReason,
  ProviderError,
  type StreamEvent,
  type Usage,
} from "@switchboard/core";
import { streamErrorBody } from "../http/errors.js";

export interface ResponseMeta {
  id: string;
  created: number;
  /** The model as the client named it, e.g. "mistral/mistral-small-latest". */
  model: string;
}

/**
 * Waits for the first event before anything is sent to the client. Until then
 * a failure can still become a proper HTTP status (and, from Week 2, be
 * retried invisibly). The returned iterator replays that first event.
 */
export async function prime(
  events: AsyncIterable<StreamEvent>,
): Promise<AsyncIterator<StreamEvent>> {
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  let replayed = false;
  return {
    next() {
      if (!replayed) {
        replayed = true;
        return Promise.resolve(first);
      }
      return iterator.next();
    },
    return(value?: unknown) {
      return iterator.return?.(value) ?? Promise.resolve({ done: true, value: undefined });
    },
  };
}

function toUsage(event: Extract<StreamEvent, { type: "usage" }>): Usage {
  return {
    prompt_tokens: event.inputTokens,
    completion_tokens: event.outputTokens,
    total_tokens: event.inputTokens + event.outputTokens,
  };
}

export function sseBody(
  events: AsyncIterator<StreamEvent>,
  meta: ResponseMeta & { includeUsage: boolean },
  onCancel: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const base = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
  } as const;
  let usage: Usage | undefined;
  let closed = false;

  const chunk = (
    delta: ChatCompletionChunk["choices"][number]["delta"],
    finish: FinishReason | null = null,
  ): string => {
    const payload: ChatCompletionChunk = {
      ...base,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    return encodeSse(JSON.stringify(payload));
  };

  const render = (event: StreamEvent): string | undefined => {
    switch (event.type) {
      case "start":
        return chunk({ role: "assistant", content: "" });
      case "delta":
        return chunk({
          ...(event.content !== undefined ? { content: event.content } : {}),
          ...(event.toolCalls ? { tool_calls: event.toolCalls } : {}),
        });
      case "usage":
        usage = toUsage(event);
        return undefined;
      case "finish":
        return chunk({}, event.reason);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        // Keep pulling until there is something to send (usage events are held back).
        for (;;) {
          const { value: event, done } = await events.next();
          if (done) {
            let tail = "";
            if (meta.includeUsage && usage) {
              tail += encodeSse(JSON.stringify({ ...base, choices: [], usage }));
            }
            tail += "data: [DONE]\n\n";
            controller.enqueue(encoder.encode(tail));
            controller.close();
            closed = true;
            return;
          }
          const out = render(event);
          if (out) {
            controller.enqueue(encoder.encode(out));
            return;
          }
        }
      } catch (error) {
        // Headers are already sent, so the failure is reported in-band, the
        // same way OpenAI does. Week 2 replaces this with resume/fallback.
        controller.enqueue(encoder.encode(encodeSse(JSON.stringify(streamErrorBody(error)))));
        controller.close();
        closed = true;
      }
    },
    async cancel(reason) {
      // The client went away: stop paying for tokens nobody will read.
      onCancel(reason);
      await events.return?.();
    },
  });
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/** Tool calls arrive as fragments keyed by index; stitch them back together. */
function mergeToolCalls(calls: ToolCall[], deltas: unknown[]): void {
  for (const raw of deltas) {
    const delta = raw as ToolCallDelta;
    const index = delta.index ?? calls.length;
    calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
    const call = calls[index];
    if (delta.id) call.id = delta.id;
    if (delta.type) call.type = delta.type;
    if (delta.function?.name) call.function.name += delta.function.name;
    if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
  }
}

export async function aggregate(
  events: AsyncIterator<StreamEvent>,
  meta: ResponseMeta,
): Promise<ChatCompletion> {
  let content = "";
  const toolCalls: ToolCall[] = [];
  let finish: FinishReason | null = null;
  let usage: Usage | undefined;

  for (;;) {
    const { value: event, done } = await events.next();
    if (done) break;
    if (event.type === "delta") {
      if (event.content) content += event.content;
      if (event.toolCalls) mergeToolCalls(toolCalls, event.toolCalls);
    } else if (event.type === "usage") {
      usage = toUsage(event);
    } else if (event.type === "finish") {
      finish = event.reason;
    }
  }

  if (finish === null) {
    throw new ProviderError({
      provider: "gateway",
      kind: "protocol",
      message: "Stream ended without finishing",
    });
  }

  return {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || (toolCalls.length ? null : ""),
          ...(toolCalls.length ? { tool_calls: toolCalls.filter(Boolean) } : {}),
        },
        finish_reason: finish,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}
