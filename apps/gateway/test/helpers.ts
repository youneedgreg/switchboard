import { parseSse } from "@switchboard/core";
import { loadConfig } from "../src/config.js";
import { createGateway } from "../src/gateway.js";
import { buildRegistry } from "../src/providers/registry.js";
import type { ProviderAdapter } from "../src/providers/types.js";

export const TEST_KEY = "sb_test_0123456789abcdef";

export function testGateway(...extra: ProviderAdapter[]) {
  const registry = new Map(buildRegistry(loadConfig({ GATEWAY_API_KEYS: TEST_KEY })));
  for (const adapter of extra) registry.set(adapter.name, adapter);
  return createGateway({ apiKeys: [TEST_KEY], registry });
}

export function chatRequest(
  body: Record<string, unknown>,
  options: { chaos?: string; signal?: AbortSignal } = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_KEY}`,
      "content-type": "application/json",
      ...(options.chaos ? { "x-mock-chaos": options.chaos } : {}),
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello gateway" }], ...body }),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

export async function sseData(res: Response): Promise<string[]> {
  const out: string[] = [];
  for await (const message of parseSse(res.body as ReadableStream<Uint8Array>)) {
    out.push(message.data);
  }
  return out;
}
