# ──────────────────────────────────────────────────────────────
# VaultRealm — Multi-stage Docker build
# Produces a lean production image (~180 MB) with:
#   • Compiled API (Fastify + TypeScript)
#   • Pre-built frontend assets (React + Vite)
#   • SQLite-ready data volume
# ──────────────────────────────────────────────────────────────

# ── Stage 1: Install ALL dependencies ───────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# pnpm is bundled with Node 22 via corepack
RUN apk add --no-cache python3 make g++ && \
    corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/bot-runner/package.json apps/bot-runner/

RUN pnpm install --frozen-lockfile

# ── Stage 2: Build frontend (Vite) ─────────────────────────
FROM deps AS build-web
WORKDIR /app

COPY apps/web/ apps/web/
COPY tsconfig.json ./

RUN pnpm --filter @vaultrealm/web run build

# ── Stage 3: Build API (TypeScript) ────────────────────────
FROM deps AS build-api
WORKDIR /app

COPY apps/api/ apps/api/
COPY tsconfig.json ./

RUN pnpm --filter @vaultrealm/api run build

# ── Stage 4: Production image ──────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

RUN apk add --no-cache python3 make g++ && \
    corepack enable && corepack prepare pnpm@9.15.4 --activate

# Install production dependencies only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/bot-runner/package.json apps/bot-runner/

RUN pnpm install --frozen-lockfile --prod && \
    apk del python3 make g++

# Copy compiled API
COPY --from=build-api /app/apps/api/dist/ apps/api/dist/

# Copy built frontend assets
COPY --from=build-web /app/apps/web/dist/ apps/web/dist/

# Copy Drizzle config and migration files (if they exist)
COPY apps/api/drizzle.config.ts apps/api/
COPY apps/api/drizzle* apps/api/

# Data volume for SQLite and server files
RUN mkdir -p /srv/vaultrealm/data
VOLUME ["/srv/vaultrealm/data"]

# Optional build arguments for baking in Google Drive OAuth credentials
ARG GOOGLE_CLIENT_ID=""
ARG GOOGLE_CLIENT_SECRET=""
ARG CLIENT_ID=""
ARG CLIENT_SECRET=""

# Runtime environment defaults
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/srv/vaultrealm/data \
    LOG_LEVEL=info \
    GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-$CLIENT_ID} \
    GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-$CLIENT_SECRET}

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3001/healthz || exit 1

# Run the API server (serves frontend assets in production)
CMD ["node", "apps/api/dist/index.js"]

LABEL org.opencontainers.image.source="https://github.com/HypertextAssassinRajith/VaultRealm" \
    org.opencontainers.image.description="VaultRealm — Self-hosted game server control panel" \
    org.opencontainers.image.licenses="MIT"
