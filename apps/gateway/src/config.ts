import { z } from "zod";

const Env = z.object({
  GATEWAY_API_KEYS: z
    .string({ error: "GATEWAY_API_KEYS is required" })
    .transform((value) =>
      value
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(16, "Gateway API keys must be at least 16 characters")).min(1)),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_BASE_URL: z.url().default("https://api.mistral.ai/v1"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.url().default("https://api.groq.com/openai/v1"),
  MOCK_BASE_URL: z.url().optional(),
  PORT: z.coerce.number().int().positive().default(8787),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings (common in .env files) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = Env.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid gateway configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
