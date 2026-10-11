/**
 * Deterministic text generation: the same prompt and seed always produce the
 * same tokens, which keeps chaos tests reproducible.
 */

export const MOCK_MODELS = ["mock-lorem", "mock-echo"] as const;
export type MockModel = (typeof MOCK_MODELS)[number];

const DEFAULT_TOKENS = 24;

// biome-ignore format: keep the word list compact
const WORDS = [
  "the", "gateway", "streams", "tokens", "through", "a", "provider", "that", "may", "fail",
  "at", "any", "moment", "so", "every", "attempt", "is", "measured", "retried", "and",
  "billed", "while", "the", "cache", "remembers", "answers", "for", "requests", "that",
  "look", "alike", "latency", "budget", "trace", "span", "fallback", "circuit", "breaker",
  "opens", "closes", "jitter", "backoff", "semantic", "vector", "similarity", "threshold",
  "router", "model", "usage", "cost", "key", "tenant", "resume", "prefix", "deadline",
  "stall", "first", "token", "switchboard", "operator",
];

/** FNV-1a 32-bit hash. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small, fast seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateTokens(
  model: MockModel,
  prompt: string,
  options: { count?: number; seed?: number } = {},
): string[] {
  let words: string[];
  if (model === "mock-echo") {
    words = prompt.split(/\s+/).filter(Boolean);
    if (words.length === 0) words = ["(empty)"];
    if (options.count !== undefined) {
      words = Array.from({ length: options.count }, (_, i) => words[i % words.length] as string);
    }
  } else {
    const random = mulberry32(hashString(prompt) ^ (options.seed ?? 0));
    const count = options.count ?? DEFAULT_TOKENS;
    words = Array.from(
      { length: count },
      () => WORDS[Math.floor(random() * WORDS.length)] as string,
    );
  }
  return words.map((word, i) => (i === 0 ? word : ` ${word}`));
}

/** Rough token estimate (~4 characters per token), good enough for a mock. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
