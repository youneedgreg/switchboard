/**
 * Vercel entry point: the default export is the Hono app. Vercel's Hono
 * detection requires this file to import "hono" itself.
 */
import type { Hono } from "hono";
import { loadConfig } from "./config.js";
import { createGateway } from "./gateway.js";
import { buildRegistry } from "./providers/registry.js";

const config = loadConfig();

const app: Hono = createGateway({
  apiKeys: config.GATEWAY_API_KEYS,
  registry: buildRegistry(config),
});

export default app;
