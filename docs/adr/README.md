# Architecture decision records

Each significant decision gets a short record in [MADR](https://adr.github.io/madr/) format:
the context, the options considered, the decision, and its consequences. Records are never
edited after acceptance; a later record supersedes an earlier one instead.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-tooling.md) | One repo with pnpm workspaces, Turborepo and uv | Accepted |
| [0002](0002-hono-on-node-runtime.md) | Hono on the Node.js runtime for the gateway | Accepted |
| [0003](0003-openai-compatible-api.md) | OpenAI-compatible API, streaming upstream always | Accepted |

Planned (see the roadmap): mid-stream failure policy, semantic cache scoping, integer money,
budget reservations, schema ownership per service, GitHub Actions as scheduler, pinning the
OpenTelemetry GenAI conventions.

## Template

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context and problem
## Options considered
## Decision
## Consequences
```
