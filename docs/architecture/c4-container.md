# C4 level 2: containers

The deployable pieces of Switchboard and how they talk to each other.

```mermaid
C4Container
    title Containers: Switchboard

    Person(dev, "Application developer", "OpenAI SDK, curl")
    Person(operator, "Operator / visitor", "Browser")

    System_Boundary(sb, "Switchboard") {
        Container(gateway, "Gateway", "TypeScript, Hono, Vercel Function", "OpenAI-compatible API. Auth, limits, budgets, cache, routing, retries, fallbacks")
        Container(mock, "Mock provider", "TypeScript, Hono", "OpenAI-compatible server that fails on command. In-process on Vercel, separate container locally")
        Container(dashboard, "Dashboard (planned)", "Next.js, Vercel", "Keys, spend, request logs, evals, playground")
        Container(evals, "Evals & analytics (planned)", "Python, FastAPI, Vercel Function", "Eval runs, cache-quality audits, cost and latency analytics")
        ContainerDb(postgres, "Postgres + pgvector (planned)", "Neon", "Keys, prices, usage ledger, semantic cache, eval results")
        ContainerDb(redis, "Redis (planned)", "Upstash", "Rate limits, budget reservations, single-flight locks, circuit state")
    }

    System_Ext(mistral, "Mistral API")
    System_Ext(groq, "Groq API")
    System_Ext(grafana, "Grafana Cloud")

    Rel(dev, gateway, "Chat completions", "HTTPS, SSE")
    Rel(operator, dashboard, "Uses", "HTTPS")
    Rel(dashboard, gateway, "Playground requests", "HTTPS, SSE")
    Rel(dashboard, evals, "Analytics, eval results", "HTTPS, JSON")
    Rel(gateway, mock, "Chaos-driven completions", "HTTPS, SSE")
    Rel(gateway, mistral, "Completions", "HTTPS, SSE")
    Rel(gateway, groq, "Completions", "HTTPS, SSE")
    Rel(gateway, postgres, "Reads/writes", "SQL")
    Rel(gateway, redis, "Counters, locks", "RESP over TLS")
    Rel(evals, postgres, "Reads gateway views, writes eval schema", "SQL")
    Rel(evals, gateway, "Runs evals through the gateway", "HTTPS")
    Rel(gateway, grafana, "Traces, metrics", "OTLP")
    Rel(evals, grafana, "Traces", "OTLP")
```

## Local equivalents

`docker compose up` runs the same containers locally, with pgvector, Redis and
`grafana/otel-lgtm` standing in for Neon, Upstash and Grafana Cloud.
