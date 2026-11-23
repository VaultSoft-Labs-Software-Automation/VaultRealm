# ── Stage 1: Build TypeScript (Native Host Architecture) ─────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app

# Pin pnpm to match package.json packageManager (9.15.4)
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy monorepo manifests for deterministic, frozen-lockfile resolution
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/bot-runner/package.json apps/bot-runner/

# Fast frozen install on native host
RUN pnpm install --frozen-lockfile

# Copy bot-runner source and root tsconfig
COPY apps/bot-runner apps/bot-runner
COPY tsconfig.json ./

# Compile TypeScript
RUN pnpm --filter @vaultrealm/bot-runner run build

# ── Stage 2: Production Dependencies (Native Host Architecture) ──────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS prod-deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/bot-runner/package.json apps/bot-runner/

# Install only production dependencies
RUN pnpm install --frozen-lockfile --prod

# ── Stage 3: Minimal Production Image (Target Architecture) ───────────────────
FROM node:22-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot-runner/package.json apps/bot-runner/
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/bot-runner/node_modules ./apps/bot-runner/node_modules
COPY --from=build /app/apps/bot-runner/dist ./apps/bot-runner/dist

USER node

CMD ["node", "apps/bot-runner/dist/index.js"]
