/**
 * Adapter for any upstream that speaks the OpenAI streaming chat format.
 * Mistral, Groq and the mock provider all do, with small differences that are
 * handled through configuration rather than separate adapters.
 */
import {
  type ChatCompletionRequest,
  type FinishReason,
  ProviderError,
  parseSse,
  type StreamEvent,
} from "@switchboard/core";
import type { ProviderAdapter, ProviderCall } from "./types.js";

export interface OpenAICompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: readonly string[];
  /** Injected for tests and for the in-process mock provider. */
  fetch?: typeof fetch;
  /** Ask for a trailing usage chunk with stream_options (OpenAI, Groq). */
  requestUsage?: boolean;
  /** Client headers forwarded upstream unchanged. */
  forwardHeaders?: readonly string[];
  /** Rewrite the request body for upstream quirks. */
  transformBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

interface UpstreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: unknown; tool_calls?: unknown[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  model_length: "length", // Mistral
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  content_filter: "content_filter",
  error: "error",
};

export function openAICompatible(config: OpenAICompatibleConfig): ProviderAdapter {
  const doFetch = config.fetch ?? fetch;
  const { name } = config;

  async function* stream({
    model,
    body,
    headers,
    signal,
  }: ProviderCall): AsyncGenerator<StreamEvent> {
    const response = await send(model, body, headers, signal);
    if (!response.body) {
      throw new ProviderError({
        provider: name,
        kind: "protocol",
        message: `${name} sent no body`,
      });
    }

    let started = false;
    let finished = false;
    try {
      for await (const message of parseSse(response.body)) {
        if (message.data === "[DONE]") break;
        const chunk = parseChunk(message.data);
        if (chunk.error) {
          throw new ProviderError({
            provider: name,
            kind: "server",
            message: `${name} stream error: ${chunk.error.message ?? "unknown"}`,
          });
        }
        if (!started) {
          started = true;
          yield { type: "start", upstreamId: chunk.id ?? "", model: chunk.model ?? model };
        }

        const choice = chunk.choices?.[0];
        const content = textOf(choice?.delta?.content);
        const toolCalls = choice?.delta?.tool_calls;
        if (content || toolCalls?.length) {
          yield {
            type: "delta",
            ...(content ? { content } : {}),
            ...(toolCalls?.length ? { toolCalls } : {}),
          };
        }
        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
        if (choice?.finish_reason) {
          finished = true;
          yield { type: "finish", reason: FINISH_REASONS[choice.finish_reason] ?? "stop" };
        }
      }
    } catch (cause) {
      if (cause instanceof ProviderError || signal.aborted) throw cause;
      throw new ProviderError({
        provider: name,
        kind: "network",
        message: `${name} stream interrupted`,
        cause,
      });
    }

    if (!finished) {
      throw new ProviderError({
        provider: name,
        kind: "protocol",
        message: `${name} stream ended before a finish_reason`,
      });
    }
  }

  async function send(
    model: string,
    body: ChatCompletionRequest,
    clientHeaders: Headers,
    signal: AbortSignal,
  ): Promise<Response> {
    // stream_options is the gateway's business with its own client, not upstream's.
    const { stream_options: _clientStreamOptions, ...rest } = body;
    let payload: Record<string, unknown> = {
      ...withoutNulls(rest),
      model,
      stream: true,
      ...(config.requestUsage ? { stream_options: { include_usage: true } } : {}),
    };
    if (config.transformBody) payload = config.transformBody(payload);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    for (const header of config.forwardHeaders ?? []) {
      const value = clientHeaders.get(header);
      if (value !== null) headers[header] = value;
    }

    let response: Response;
    try {
      response = await doFetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new ProviderError({
        provider: name,
        kind: "network",
        message: `${name} is unreachable`,
        cause,
      });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw ProviderError.fromStatus(name, response.status, response.headers, detail);
    }
    return response;
  }

  function parseChunk(data: string): UpstreamChunk {
    try {
      return JSON.parse(data) as UpstreamChunk;
    } catch (cause) {
      throw new ProviderError({
        provider: name,
        kind: "protocol",
        message: `${name} sent malformed JSON in the stream`,
        cause,
      });
    }
  }

  return { name, models: config.models, stream };
}

/** Content is usually a string, but some models (e.g. Mistral reasoning) send parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function withoutNulls(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value != null));
}
