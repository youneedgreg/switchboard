import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { openAIError } from "./errors.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Static bearer-token auth from configuration. Week 3 replaces this with
 * hashed, per-org API keys in Postgres. Comparing fixed-length digests in
 * constant time avoids leaking key prefixes through response timing.
 */
export function bearerAuth(keys: readonly string[]): MiddlewareHandler {
  const accepted = keys.map(digest);

  return async (c, next) => {
    const match = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    const presented = match?.[1] ? digest(match[1].trim()) : undefined;
    const ok = presented !== undefined && accepted.some((key) => timingSafeEqual(key, presented));
    if (!ok) {
      return c.json(
        openAIError("Missing or invalid API key", "authentication_error", "invalid_api_key"),
        401,
      );
    }
    await next();
  };
}
