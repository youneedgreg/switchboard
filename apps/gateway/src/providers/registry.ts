import { CHAOS_HEADER, createMockApp, MOCK_MODELS } from "@switchboard/mock-provider";
import type { Config } from "../config.js";
import { openAICompatible } from "./openai-compatible.js";
import type { ProviderAdapter } from "./types.js";

export type ProviderRegistry = ReadonlyMap<string, ProviderAdapter>;

/**
 * Models are addressed as "provider/model", e.g. "mistral/mistral-small-latest".
 * The prefix picks the adapter; the rest is passed upstream unchanged.
 */
export function resolveModel(
  registry: ProviderRegistry,
  model: string,
): { adapter: ProviderAdapter; upstreamModel: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  const adapter = registry.get(model.slice(0, slash));
  return adapter ? { adapter, upstreamModel: model.slice(slash + 1) } : undefined;
}

export function buildRegistry(config: Config): ProviderRegistry {
  const adapters: ProviderAdapter[] = [mockAdapter(config.MOCK_BASE_URL)];

  if (config.MISTRAL_API_KEY) {
    adapters.push(
      openAICompatible({
        name: "mistral",
        baseUrl: config.MISTRAL_BASE_URL,
        apiKey: config.MISTRAL_API_KEY,
        models: ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest"],
        // Mistral includes usage on its final chunk without being asked, and
        // rejects OpenAI-only fields, so translate them.
        transformBody: ({ seed, max_completion_tokens, user: _user, ...rest }) => ({
          ...rest,
          ...(seed !== undefined ? { random_seed: seed } : {}),
          ...(max_completion_tokens !== undefined && rest.max_tokens === undefined
            ? { max_tokens: max_completion_tokens }
            : {}),
        }),
      }),
    );
  }

  if (config.GROQ_API_KEY) {
    adapters.push(
      openAICompatible({
        name: "groq",
        baseUrl: config.GROQ_BASE_URL,
        apiKey: config.GROQ_API_KEY,
        models: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
        requestUsage: true,
      }),
    );
  }

  return new Map(adapters.map((adapter) => [adapter.name, adapter]));
}

/**
 * The mock provider runs in-process unless MOCK_BASE_URL points at a separate
 * server. In-process keeps the public demo free and dependency-less; the
 * separate server exercises real network failures.
 */
function mockAdapter(baseUrl: string | undefined): ProviderAdapter {
  const inProcess = baseUrl === undefined;
  const app = inProcess ? createMockApp() : undefined;
  return openAICompatible({
    name: "mock",
    baseUrl: baseUrl ?? "http://mock.internal/v1",
    models: MOCK_MODELS,
    forwardHeaders: [CHAOS_HEADER],
    ...(app ? { fetch: async (input, init) => app.fetch(new Request(input, init)) } : {}),
  });
}
