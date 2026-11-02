# 0004. Mid-stream failure policy: resume by default, abort on request

- Status: Accepted
- Date: 2026-11-02

## Context and problem

Once tokens have reached the client, the response status is already `200` and a failure can't be
hidden by starting again: the client would receive the opening of the answer twice. What should
the gateway do when a provider fails at token 20?

## Options considered

1. **Abort.** Send a final SSE error and stop, as OpenAI does. Simple and always truthful, but the
   client loses the answer and pays to generate it again.
2. **Hold back the whole answer** until it completes, then stream it. Failures stay invisible, but
   this removes the reason to stream at all.
3. **Resume.** Give the next attempt the partial answer so it can continue, remove any overlap,
   and keep one stream open. The client gets an answer, but one that two generations wrote.

## Decision

Support both abort and resume, chosen by policy. **Resume is the default.** The gateway default
comes from `MID_STREAM_POLICY`, a request can override it with `x-switchboard-mid-stream`, and
Week 3 makes it a per-key setting.

- **How to continue:** Mistral receives an assistant message marked `prefix: true`. Other providers
  receive the partial answer and a follow-up message asking them to continue.
- **Overlap:** the start of a continuation is held while it could still be a repeat of the answer
  so far, and any repeat of at least 4 characters is removed. This covers both a full echo of the
  prefix and a model restarting its last sentence.
- **Never resumed:** a stream that has sent a tool call, because half its arguments can't be
  continued; structured output, because a continuation may start a new JSON document; and a failure
  classified `bad_request`, which would fail again.
- **Limits:** a resume is an ordinary attempt. It uses the same retry and fallback rules, retry
  budget and total deadline. An estimate of what was already sent comes off the client's
  `max_tokens`.
- **Reporting:** response headers are sent before any failure, so they can't announce a resume. The
  finish chunk carries a `switchboard` object with `resumed`, `resumes`, `provider`, `model` and
  `attempts`. SDKs ignore fields they don't know.

## Consequences

- Clients get complete answers through provider failures, using any OpenAI SDK.
- A resumed answer can shift in tone or quality at the join, especially across providers. A client
  that can't accept this sets `abort`, and every resumed answer is marked so it can be detected.
- `x-switchboard-provider` names the provider that started the stream, which may not be the one
  that finished it. The finish chunk has the final say.
- Each resume sends the partial answer back as input, and failed attempts are billed by the
  provider. Week 3's cost tracking must record every attempt.
- Reported usage is the final attempt's alone, until Week 3 adds attempts together.
- Resumed answers must never enter the cache. Week 4 needs to honour this.
- A failure after the finish chunk is treated as success: the answer is complete, and only the
  trailing usage or `[DONE]` was lost.
