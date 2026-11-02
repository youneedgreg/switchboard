/**
 * Mid-stream resume: asking the next attempt to carry on from a partial answer,
 * and removing whatever it repeats of what the client has already received.
 */
import { type ChatCompletionRequest, CONTINUE_PROMPT } from "@switchboard/core";
import type { ResumeStyle } from "../providers/types.js";

/** Shorter matches are more likely to be coincidence than a repeat. */
const MIN_OVERLAP = 4;
const CHARS_PER_TOKEN = 4;

/**
 * Whether a partial answer to this request can be continued. Structured output
 * is not: a provider told to "continue" may start a new JSON document, and no
 * trimming can repair that.
 */
export function canResumeRequest(body: ChatCompletionRequest): boolean {
  const format = body.response_format as { type?: string } | null | undefined;
  return !format || format.type === "text";
}

/** The request for a next attempt, carrying the answer so far. */
export function continuationBody(
  body: ChatCompletionRequest,
  partial: string,
  style: ResumeStyle,
): ChatCompletionRequest {
  const messages: ChatCompletionRequest["messages"] =
    style === "prefix"
      ? [...body.messages, { role: "assistant", content: partial, prefix: true }]
      : [
          ...body.messages,
          { role: "assistant", content: partial },
          { role: "user", content: CONTINUE_PROMPT },
        ];

  // The client's token limit covers the whole answer, not each attempt.
  const used = Math.ceil(partial.length / CHARS_PER_TOKEN);
  const remaining = (limit: number) => Math.max(1, limit - used);
  return {
    ...body,
    messages,
    ...(body.max_tokens ? { max_tokens: remaining(body.max_tokens) } : {}),
    ...(body.max_completion_tokens
      ? { max_completion_tokens: remaining(body.max_completion_tokens) }
      : {}),
  };
}

export interface OverlapTrimmer {
  /** Takes the next piece of a continuation; returns what is safe to send. */
  push(text: string): string;
  /** The stream has ended, so whatever is held must be decided now. */
  flush(): string;
}

/**
 * Removes the start of a continuation where it repeats the end of `sent`.
 * Providers do this in different amounts: Mistral echoes a whole prefix, and a
 * model told to continue often restarts its last sentence. The text arrives in
 * pieces, so it is held while it could still turn out to be a longer repeat.
 */
export function overlapTrimmer(sent: string): OverlapTrimmer {
  let held = "";
  let decided = false;

  const decide = (): string => {
    decided = true;
    for (let length = Math.min(held.length, sent.length); length >= MIN_OVERLAP; length--) {
      if (sent.endsWith(held.slice(0, length))) return held.slice(length);
    }
    return held;
  };

  /** True while `held` appears in `sent` somewhere other than at its very end. */
  const couldGrow = (): boolean => {
    const position = sent.indexOf(held);
    return position !== -1 && position + held.length < sent.length;
  };

  return {
    push(text) {
      if (decided) return text;
      held += text;
      return couldGrow() ? "" : decide();
    },
    flush() {
      return decided ? "" : decide();
    },
  };
}
