/**
 * The instruction sent after a partial answer to a provider that cannot continue
 * from a prefix. Shared so that the mock provider can recognise a continuation.
 */
export const CONTINUE_PROMPT =
  "Your previous message was cut off. Continue it from exactly where it stopped. " +
  "Do not repeat anything or add any introduction.";
