# Switchboard

An LLM gateway: an OpenAI-compatible streaming proxy with provider fallbacks, retries, semantic
caching and cost tracking per API key, plus a Python service for evals and analytics, all traced
with OpenTelemetry GenAI conventions.

The hard parts it is built to get right:

- **Streaming through failures.** A provider can die at token 20. Switchboard decides, per key,
  whether to fail cleanly or resume the answer on another provider.
- **Cache correctness.** A semantic cache that never answers one tenant with another tenant's
  context, and whose false-positive rate is measured, not guessed.

> **Status: Week 1 of 6.** The streaming gateway, the chaos mock provider, tests, Docker and CI
> are built. See [ROADMAP.md](ROADMAP.md) for what comes next.

## Try it

Any OpenAI SDK works; change the base URL and key.

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:8787/v1", apiKey: "sb_local_dev_key_change_me" });

const stream = await client.chat.completions.create({
  model: "mock/mock-lorem", // or "mistral/mistral-small-latest"
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta.content ?? "");
```

### Break it on purpose

The mock provider fails on command through the `x-mock-chaos` header:

```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H "authorization: Bearer sb_local_dev_key_change_me" \
  -H "content-type: application/json" \
  -H "x-mock-chaos: token_ms=80; drop_after=10" \
  -d '{"model":"mock/mock-lorem","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

| Switch | Effect |
|---|---|
| `status=503` | Fail with this HTTP status before streaming |
| `retry_after=5` | `Retry-After` seconds sent with the failure |
| `fail_rate=0.3` | Fail this fraction of requests (with `status`, default 503) |
| `ttft_ms=800` | Delay before the first chunk |
| `token_ms=50` | Delay between tokens |
| `tokens=200` | Response length |
| `drop_after=N` | Cut the connection before token N |
| `stall_after=N` | Stop sending, keep the connection open, before token N |
| `malformed_after=N` | Send invalid JSON before token N |
| `error_after=N` | Send an in-stream error object before token N |
| `seed=42` | Make output and `fail_rate` deterministic |

## Run locally

Requirements: Node 24, pnpm 10, Docker.

```bash
docker compose up --build
```

This starts the gateway (`:8787`), the mock provider (`:8788`), Postgres with pgvector, Redis,
and Grafana with an OpenTelemetry collector (`:3000`). Add `MISTRAL_API_KEY` or `GROQ_API_KEY`
to a root `.env` file to enable real providers.

Without Docker:

```bash
pnpm install
cp apps/gateway/.env.example apps/gateway/.env   # then set GATEWAY_API_KEYS
pnpm dev
```

Without `MOCK_BASE_URL`, the gateway runs the mock provider in-process.

## Develop

```bash
pnpm test        # all tests, via Turborepo
pnpm typecheck
pnpm lint        # Biome
pnpm fix         # format and auto-fix
```

## Repository layout

```
apps/gateway        OpenAI-compatible gateway (Hono, TypeScript)
apps/mock-provider  OpenAI-compatible server with fault injection
packages/core       SSE parser, wire types, stream events, provider errors
infra/docker        Dockerfile shared by the Node services
docs/               design doc, architecture diagrams, decision records
```

## Documentation

- [Design doc: the gateway](docs/design/gateway.md)
- [C4 context](docs/architecture/c4-context.md) · [C4 containers](docs/architecture/c4-container.md)
- [Architecture decision records](docs/adr/README.md)
- [Roadmap](ROADMAP.md)
