# C4 level 1: system context

Who uses Switchboard and which outside systems it depends on.

```mermaid
C4Context
    title System context: Switchboard

    Person(dev, "Application developer", "Calls LLMs from their app through an OpenAI SDK")
    Person(operator, "Operator", "Manages API keys, budgets, routes and evals")
    Person(visitor, "Portfolio visitor", "Tries the public playground from temwa.dev")

    System(switchboard, "Switchboard", "LLM gateway: streaming proxy with fallbacks, retries, caching, cost tracking, evals")

    System_Ext(mistral, "Mistral API", "Primary LLM and embedding provider")
    System_Ext(groq, "Groq API", "Fallback LLM provider")
    System_Ext(grafana, "Grafana Cloud", "Traces, metrics, logs, alerting")
    System_Ext(discord, "Discord", "Budget alert notifications")
    System_Ext(github, "GitHub", "Dashboard sign-in, CI, scheduled eval jobs")

    Rel(dev, switchboard, "Chat completions", "HTTPS, SSE")
    Rel(operator, switchboard, "Configures, reviews spend and evals", "HTTPS")
    Rel(visitor, switchboard, "Breaks streams on purpose in the playground", "HTTPS")
    Rel(switchboard, mistral, "Completions, embeddings", "HTTPS, SSE")
    Rel(switchboard, groq, "Completions on fallback", "HTTPS, SSE")
    Rel(switchboard, grafana, "Telemetry", "OTLP")
    Rel(switchboard, discord, "Budget alerts", "Webhook")
    Rel(github, switchboard, "Nightly evals and cache audits", "HTTPS")
```

**Built in Week 1:** the gateway path from developer to Mistral, Groq and the mock provider.
Everything else on this diagram is planned; see [ROADMAP.md](../../ROADMAP.md).
