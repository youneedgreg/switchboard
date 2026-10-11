# 0001. One repo with pnpm workspaces, Turborepo and uv

- Status: Accepted
- Date: 2026-10-11

## Context and problem

Switchboard has a TypeScript gateway, a TypeScript mock provider, a Next.js dashboard, shared
TypeScript packages, and a Python service. They share an API contract and a database, and
change together: a new field in the usage ledger touches the gateway, the Python analytics and
the dashboard in one go. How should the code be organised?

## Options considered

1. **Separate repositories per service.** Clear ownership, but every cross-cutting change
   becomes several coordinated pull requests, and shared types must be published as packages.
2. **One repository, npm/Yarn workspaces, no task runner.** Simple, but every CI run builds and
   tests everything.
3. **One repository, pnpm workspaces + Turborepo for TypeScript, uv for Python.**

## Decision

Option 3.

- **pnpm** for its strict, non-flat `node_modules` (a package cannot import what it does not
  declare) and a content-addressed store that keeps installs fast.
- **Turborepo** to run `build`, `typecheck` and `test` in dependency order, cache the results,
  and later run only what a change affects (`--filter=...[origin/main]`).
- **uv** for the Python service (Week 4): one fast tool for the interpreter, virtualenv,
  lockfile and scripts. Python lives in `services/` and is not a pnpm workspace; Turborepo can
  still drive it through a `package.json` with script wrappers if that proves useful.
- **Biome** instead of ESLint + Prettier: one fast tool for linting, formatting and import
  sorting, with one config file.

Internal packages (`@switchboard/core`) compile to `dist/` with `tsc` rather than being consumed
as TypeScript source, so every consumer (Vitest, `tsx`, Docker, Vercel's bundler) sees ordinary
JavaScript with type declarations.

## Consequences

- One pull request can change the contract and all its users atomically.
- `turbo prune --docker` produces a minimal workspace per service for Docker builds.
- Packages must be built before their consumers typecheck; Turborepo's `dependsOn: ["^build"]`
  handles this, but editors may show stale types until a rebuild.
- Two ecosystems (pnpm and uv) in one repo means two lockfiles and two CI setups.
