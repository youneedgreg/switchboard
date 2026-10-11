/** Vercel entry point: the default export is the Hono app. */

import { loadConfig } from "./config.js";
import { createGateway } from "./gateway.js";
import { buildRegistry } from "./providers/registry.js";

const config = loadConfig();

export default createGateway({
  apiKeys: config.GATEWAY_API_KEYS,
  registry: buildRegistry(config),
});
