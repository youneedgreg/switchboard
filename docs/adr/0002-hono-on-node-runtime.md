# 0002. Hono on the Node.js runtime for the gateway

- Status: Accepted
- Date: 2026-10-11

## Context and problem

The gateway holds long-lived streaming responses open, needs fine control over when response
headers are sent, must cancel upstream requests when clients leave, and has to run both on
Vercel's free tier and in a plain Docker container. Which HTTP framework and runtime?

## Options considered

1. **Express or Fastify on Node.js.** Mature, but built on Node's `req`/`res` objects rather
   than the web-standard `Request`/`Response`/`ReadableStream`, which is what `fetch`, the OpenAI
   SDK and Vercel all speak.
2. **Next.js route handlers.** Web-standard, but ties the API to the dashboard's framework,
   release cycle and build.
3. **Hono on the Node.js runtime.** Small, web-standard (`app.fetch(Request): Response`), runs
   unchanged on Vercel (zero-config) and on Node through `@hono/node-server`.
4. **Hono on an edge runtime.** Vercel's Edge runtime is deprecated in favour of Node.js on
   Fluid Compute, and lacks parts of the Node API (for example `node:crypto` helpers).

## Decision

Option 3.

## Consequences

- The whole app is a function from `Request` to `Response`. Tests call `app.request()` directly
  with no network, and the mock provider can run **in-process** inside the gateway by handing
  its `fetch` to the adapter. The public demo therefore needs no second deployment.
- Streaming uses a pull-based `ReadableStream`: the gateway only reads the next upstream event
  when the client is ready for more (backpressure), and `cancel()` fires when the client leaves.
- Vercel Functions now default to a 300 s maximum duration, which bounds the longest stream.
- Some Node-specific behaviour (for example how a closed socket is surfaced) differs between
  `@hono/node-server` and Vercel; the OpenAI SDK test suite runs against a real Node server to
  catch these differences.
