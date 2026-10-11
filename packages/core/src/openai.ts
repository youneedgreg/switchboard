/**
 * The subset of the OpenAI Chat Completions wire format that Switchboard speaks.
 * Unknown request fields are kept (loose objects) so they can be forwarded upstream.
 */
import { z } from "zod";

const ContentPart = z.looseObject({ type: z.string() });

export const ChatMessage = z.looseObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.looseObject({})).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatCompletionRequest = z.looseObject({
  model: z.string().min(1),
  messages: z.array(ChatMessage).min(1),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  stop: z.union([z.string(), z.array(z.string())]).nullish(),
  seed: z.number().int().nullish(),
  n: z
    .number()
    .int()
    .refine((n) => n === 1, { message: "Only n=1 is supported" })
    .nullish(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string; tool_calls?: unknown[] };
    finish_reason: FinishReason | null;
  }>;
  usage?: Usage | null;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: unknown[] };
    finish_reason: FinishReason | null;
  }>;
  usage?: Usage;
}

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    code: string | null;
    param?: string | null;
  };
}
