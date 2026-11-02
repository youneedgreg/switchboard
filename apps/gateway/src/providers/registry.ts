import {
  ATTEMPT_HEADER,
  CHAOS_HEADER,
  createMockApp,
  MOCK_MODELS,
} from "@switchboard/mock-provider";
import type { Config } from "../config.js";
import type { AttemptTarget } from "../resilience/attempts.js";
import { openAICompatible } from "./openai-compatible.js";
import type { ProviderAdapter } from "./types.js";

export type ProviderRegistry = ReadonlyMap<string, ProviderAdapter>;

const ROUTE_PREFIX = "route/";

/**
 * Named fallback chains. Models from providers without an API key are left out.
 * The real route never includes the mock: a client asking for a model must not
 * be answered with lorem ipsum because the real providers are down.
 */
const ROUTES: Readonly<Record<string, readonly string[]>> = {
  default: ["mistral/mistral-small-latest", "groq/llama-3.3-70b-versatile"],
  demo: ["mock/mock-lorem", "mock-backup/mock-lorem"],
};

function resolveModel(registry: ProviderRegistry, model: string): AttemptTarget | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  const adapter = registry.get(model.slice(0, slash));
  return adapter ? { adapter, upstreamModel: model.slice(slash + 1) } : undefined;
}

function routeTargets(registry: ProviderRegistry, models: readonly string[]): AttemptTarget[] {
  return models.flatMap((model) => resolveModel(registry, model) ?? []);
}

/** The ids of the routes that have at least one usable model. */
export function routeIds(registry: ProviderRegistry): string[] {
  return Object.entries(ROUTES)
    .filter(([, models]) => routeTargets(registry, models).length > 0)
    .map(([name]) => `${ROUTE_PREFIX}${name}`);
}

/**
 * Models are addressed as "provider/model", e.g. "mistral/mistral-small-latest",
 * where the prefix picks the adapter and the rest is passed upstream unchanged;
 * or as "route/name", which expands to a fallback chain. Returns an empty chain
 * if the model cannot be served.
 */
export function resolveTargets(registry: ProviderRegistry, model: string): AttemptTarget[] {
  if (model.startsWith(ROUTE_PREFIX)) {
    return routeTargets(registry, ROUTES[model.slice(ROUTE_PREFIX.length)] ?? []);
  }
  const target = resolveModel(registry, model);
  return target ? [target] : [];
}

export function buildRegistry(config: Config): ProviderRegistry {
  const adapters: ProviderAdapter[] = [
    mockAdapter("mock", config.MOCK_BASE_URL),
    mockAdapter("mock-backup", config.MOCK_BASE_URL),
  ];

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
function mockAdapter(name: string, baseUrl: string | undefined): ProviderAdapter {
  const inProcess = baseUrl === undefined;
  const app = inProcess ? createMockApp() : undefined;
  return openAICompatible({
    name,
    baseUrl: baseUrl ?? "http://mock.internal/v1",
    models: MOCK_MODELS,
    forwardHeaders: [CHAOS_HEADER],
    attemptHeader: ATTEMPT_HEADER,
    ...(app ? { fetch: async (input, init) => app.fetch(new Request(input, init)) } : {}),
  });
}
