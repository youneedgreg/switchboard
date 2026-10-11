/** Local / container entry point. */
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createGateway } from "./gateway.js";
import { buildRegistry } from "./providers/registry.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const config = loadConfig();
const registry = buildRegistry(config);
const app = createGateway({ apiKeys: config.GATEWAY_API_KEYS, registry });

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`gateway listening on http://localhost:${info.port}`);
  console.log(`providers: ${[...registry.keys()].join(", ")}`);
});
