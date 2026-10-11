# syntax=docker/dockerfile:1
# Builds one Node service from the monorepo, e.g.:
#   docker build -f infra/docker/node.Dockerfile --build-arg APP=@switchboard/gateway .
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
RUN corepack enable
WORKDIR /repo

# 1. Keep only the target app and the workspace packages it depends on.
FROM base AS pruner
ARG APP
COPY . .
RUN pnpm dlx turbo@2.11.7 prune "${APP}" --docker

# 2. Install from the pruned lockfile first so dependency layers stay cached.
FROM base AS builder
ARG APP
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
# turbo prune keeps workspace packages only; shared root config is copied explicitly.
COPY tsconfig.base.json ./
RUN pnpm turbo run build --filter="${APP}"
RUN pnpm --filter="${APP}" deploy --prod --legacy /app

# 3. Production image: compiled JS and production dependencies only.
FROM node:${NODE_VERSION}-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /app .
USER node
CMD ["node", "dist/main.js"]
