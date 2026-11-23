# VaultRealm — Developer Guide

> Everything you need to start contributing, understand the architecture, and ship features.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Backend (apps/api)](#backend-appsapi)
  - [Entry Point & Startup](#entry-point--startup)
  - [Configuration (.env)](#configuration-env)
  - [Database (SQLite + Drizzle)](#database-sqlite--drizzle)
  - [Authentication & Sessions](#authentication--sessions)
  - [RBAC (Role-Based Access Control)](#rbac-role-based-access-control)
  - [Docker Driver Interface](#docker-driver-interface)
  - [Server Lifecycle & Deploy Pipeline](#server-lifecycle--deploy-pipeline)
  - [Game Templates](#game-templates)
  - [Quota Engine](#quota-engine)
  - [Diagnosis Engine](#diagnosis-engine)
  - [Realtime WebSocket Gateway](#realtime-websocket-gateway)
  - [Audit Logging](#audit-logging)
- [Frontend (apps/web)](#frontend-appsweb)
  - [Routing & App Shell](#routing--app-shell)
  - [Components](#components)
  - [API Client](#api-client)
  - [Styling System](#styling-system)
- [API Reference](#api-reference)
- [Testing](#testing)
- [Adding a New Game Template](#adding-a-new-game-template)
- [Adding a New API Route](#adding-a-new-api-route)
- [Adding a Diagnosis Rule](#adding-a-diagnosis-rule)
- [Docker & CI/CD](#docker--cicd)
- [Code Conventions](#code-conventions)

---

## Quick Start

```bash
# Prerequisites: Node.js 22+, pnpm 9+
git clone https://github.com/HypertextAssassinRajith/VaultRealm.git
cd VaultRealm

# 1. Install dependencies
pnpm install

# 2. Configure environment
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env — set PANEL_SECRET to a random 16+ char string

# 3. Start dev servers (API on :3001, Frontend on :5173)
pnpm dev

# 4. Open http://localhost:5173
# First-time setup creates an admin account automatically.
```

### Default Credentials (Dev)

| Field    | Value                     |
|----------|---------------------------|
| Username | `admin`                   |
| Email    | `admin@vaultrealm.local`  |
| Password | `AdminSecurePassword123!` |

### Key Commands

```bash
pnpm dev          # Start API + frontend in parallel
pnpm test         # Run all 125+ backend tests
pnpm typecheck    # TypeScript strict check (both apps)
pnpm lint         # ESLint (both apps)
pnpm build        # Production build
pnpm db:generate  # Generate Drizzle migrations
pnpm db:migrate   # Run pending migrations
pnpm docker:build     # Build panel container (vaultrealm:latest)
pnpm docker:build:bot # Build companion bot container (vaultrealm/bot-runner:latest)
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (React)                      │
│  Dashboard │ ServerView │ DeployWizard │ AdminView        │
│                                                          │
│  HTTP (fetch)           SSE (EventSource)    WS           │
└────────┬────────────────────┬──────────────┬─────────────┘
         │                    │              │
    ┌────▼────────────────────▼──────────────▼──────┐
    │                  Vite Dev Proxy                 │
    │     /api → :3001    /ws → ws://:3001           │
    └────┬───────────────────────────────────────────┘
         │
    ┌────▼──────────────────────────────────────────┐
    │              Fastify API Server (:3001)        │
    │                                                │
    │  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
    │  │   Auth   │  │ Servers  │  │   Realtime   │ │
    │  │  Routes  │  │  Routes  │  │   Gateway    │ │
    │  └────┬─────┘  └────┬─────┘  └──────┬───────┘ │
    │       │             │               │          │
    │  ┌────▼─────────────▼───────────────▼───────┐ │
    │  │            Service Layer                   │ │
    │  │  RBAC │ Sessions │ Quota │ Deploy │ Diag  │ │
    │  └───────────────────┬───────────────────────┘ │
    │                      │                          │
    │  ┌───────────────────▼───────────────────────┐ │
    │  │          DockerDriver Interface            │ │
    │  │  MockDockerDriver (dev) │ RealDockerDriver │ │
    │  └───────────────────┬───────────────────────┘ │
    │                      │                          │
    │  ┌───────────────────▼───────────────────────┐ │
    │  │          SQLite (via Drizzle ORM)          │ │
    │  │          File: data/panel.db               │ │
    │  └───────────────────────────────────────────┘ │
    └────────────────────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │   Docker    │
                    │   Engine    │
                    │  (socket)   │
                    └─────────────┘
```

### Key Design Decisions

1. **Docker access is abstracted** — All container operations go through the `DockerDriver` interface. In dev, `MockDockerDriver` simulates containers in-memory. In production, `RealDockerDriver` talks to the Docker socket. Never call `dockerode` directly.

2. **SQLite, not Postgres** — Keeps deployment simple (no separate DB container). Drizzle ORM provides type-safe queries. The DB file lives at `DATA_DIR/panel.db`.

3. **Cookie-based auth** — Sessions use signed HMAC tokens stored in httpOnly cookies. No JWTs, no localStorage. `EventSource` and `WebSocket` both work because cookies are sent automatically.

4. **Monorepo with pnpm workspaces** — Two apps (`apps/api` and `apps/web`) share a root `tsconfig.json` and toolchain.

---

## Project Structure

```
VaultRealm/
├── apps/
│   ├── api/                        # Fastify backend
│   │   ├── src/
│   │   │   ├── index.ts            # Entry point — bootstraps Fastify
│   │   │   ├── config.ts           # Zod-validated env config
│   │   │   ├── validation.ts       # Request body validation helper
│   │   │   ├── auth/               # Authentication module
│   │   │   │   ├── routes.ts       # Login, register, logout, invites
│   │   │   │   ├── middleware.ts   # requireAuth, extractUser
│   │   │   │   ├── sessions.ts    # Token create/verify, cookie config
│   │   │   │   ├── rbac.ts        # can() permission checker
│   │   │   │   └── rate-limit.ts  # Login/register rate limiting
│   │   │   ├── db/                 # Database layer
│   │   │   │   ├── schema.ts      # Drizzle table definitions
│   │   │   │   └── index.ts       # Init, migrate, close
│   │   │   ├── docker/             # Docker abstraction
│   │   │   │   ├── driver.ts      # DockerDriver interface & types
│   │   │   │   ├── real.ts        # Real Docker implementation
│   │   │   │   └── mock.ts        # In-memory mock for dev/tests
│   │   │   ├── servers/            # Server management
│   │   │   │   ├── routes.ts      # All /api/servers/* endpoints
│   │   │   │   ├── service.ts     # Business logic (CRUD, power)
│   │   │   │   ├── deploy.ts      # 9-step deploy state machine
│   │   │   │   ├── templates.ts   # Game template registry
│   │   │   │   ├── ports.ts       # Port allocator
│   │   │   │   ├── quota.ts       # User & host quota engine
│   │   │   │   ├── volume.ts      # Server volume preparation
│   │   │   │   ├── console.ts     # Command execution via Docker
│   │   │   │   └── debug-bundle.ts # Debug ZIP generator
│   │   │   ├── diagnosis/          # Auto-diagnosis engine
│   │   │   │   ├── engine.ts      # Rule evaluator & fix applier
│   │   │   │   └── types.ts       # Shared types
│   │   │   ├── realtime/           # WebSocket layer
│   │   │   │   └── gateway.ts     # /ws/servers/:id multiplexer
│   │   │   └── audit/              # Audit logging
│   │   │       └── log.ts         # writeAudit()
│   │   ├── test/                   # 125+ integration tests
│   │   │   ├── helpers.ts         # Test app builder & utilities
│   │   │   ├── fixtures/          # Log fixtures for diagnosis tests
│   │   │   └── *.test.ts          # Test files
│   │   ├── .env.example           # Environment template
│   │   ├── drizzle.config.ts      # Drizzle Kit config
│   │   └── vitest.config.ts       # Test runner config
│   │
│   └── web/                        # React frontend
│       ├── src/
│       │   ├── main.tsx           # React entry point
│       │   ├── App.tsx            # Root component & router
│       │   ├── index.css          # Design system & Tailwind config
│       │   ├── api/
│       │   │   └── client.ts      # Typed API client (fetch wrapper)
│       │   └── components/
│       │       ├── AuthModal.tsx   # Login/register modal
│       │       ├── Dashboard.tsx  # Server list, metrics, quotas
│       │       ├── ServerView.tsx  # Server detail (tabs: overview, console, debug, settings)
│       │       ├── DeployWizard.tsx # 3-step deploy modal with SSE progress
│       │       ├── AdminView.tsx  # Invite management, host stats
│       │       ├── Toast.tsx      # Toast notification system
│       │       └── ConfirmModal.tsx # Themed confirmation dialog
│       └── vite.config.ts         # Vite + proxy config
│
├── docs/                           # Additional documentation
├── docker-compose.yml             # Production stack
├── Dockerfile                     # Multi-stage build
├── Caddyfile                      # Reverse proxy + auto TLS
├── .github/workflows/             # CI/CD
│   └── docker-publish.yml         # Build & push to GHCR
├── AGENTS.md                      # AI agent coding rules
├── IMPLEMENTATION_PLAN.md         # Full feature roadmap
└── pnpm-workspace.yaml           # Monorepo config
```

---

## Backend (apps/api)

### Entry Point & Startup

[`src/index.ts`](apps/api/src/index.ts) boots the application in this order:

1. Load & validate environment config (`loadConfig()`)
2. Initialize Fastify with pino logging
3. Register plugins (CORS, cookies, WebSocket)
4. Initialize SQLite database + run migrations
5. Set Docker driver (Mock in dev, Real in prod)
6. Register routes (auth → realtime → servers)
7. Start listening on `PORT`

### Configuration (.env)

Copy `apps/api/.env.example` → `apps/api/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PANEL_SECRET` | *(required)* | 16+ char secret for session signing |
| `PORT` | `3001` | API listen port |
| `DATA_DIR` | `./data` | SQLite DB + server volumes directory |
| `PORT_RANGE` | `25000-29999` | Host port range for game servers |
| `HOST_RAM_BUDGET_PCT` | `85` | Max % of host RAM for all servers |
| `LOG_LEVEL` | `info` | Pino log level |
| `NODE_ENV` | `development` | `development` / `production` / `test` |
| `CORS_ORIGIN` | `http://localhost:5173` | Frontend origin for CORS |
| `ALLOW_PRIVATE_LLM_ENDPOINTS` | `false` | Allow LLM endpoints on private IPs |

### Database (SQLite + Drizzle)

**Schema** is defined in [`src/db/schema.ts`](apps/api/src/db/schema.ts). Tables:

| Table | Purpose |
|-------|---------|
| `users` | User accounts with quotas |
| `invites` | Registration invite codes |
| `servers` | Game server records |
| `server_ports` | Port bindings per server |
| `server_members` | Sub-user access (permissions JSON) |
| `events` | Lifecycle event timeline |
| `diagnoses` | Stored diagnosis results |
| `audit_log` | Mutation audit trail |

**Adding a column:**
1. Edit `src/db/schema.ts`
2. Run `pnpm db:generate` → creates migration SQL
3. Run `pnpm db:migrate` → applies to SQLite

### Authentication & Sessions

- **First user** registered becomes `admin` (no invite needed)
- **Subsequent users** require a valid invite code
- Sessions are HMAC-signed tokens in httpOnly cookies
- Cookie name: `vr_session` (defined in `sessions.ts`)
- Token payload: `{ sub: userId, role: 'admin' | 'user' }`
- Rate limiting: 10 login attempts / 60s, 5 registrations / 60s

### RBAC (Role-Based Access Control)

**Every route must call `can()` or `assertCan()`** before performing actions.

```typescript
// In a route handler:
const user = getRequestUser(request);
await assertCan(user, 'server:view', serverId); // throws 403 if denied
```

Permission resolution order:
1. **Admin** → always allowed
2. **Server owner** → allowed for own servers
3. **Server member** → check `permissions_json` (e.g., `{ console: true }`)
4. **Otherwise** → denied

Available actions: `server:list`, `server:create`, `server:view`, `server:power`, `server:delete`, `server:console`, `server:settings`, `server:files`, `server:backups`, `server:members`, `server:diagnosis`, `auth:manage-invites`, `admin:*`

### Docker Driver Interface

All Docker access goes through [`DockerDriver`](apps/api/src/docker/driver.ts):

```typescript
interface DockerDriver {
  createContainer(opts: ContainerCreateOptions): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeout?: number): Promise<void>;
  killContainer(id: string, signal?: string): Promise<void>;
  restartContainer(id: string, timeout?: number): Promise<void>;
  removeContainer(id: string, removeVolumes?: boolean): Promise<void>;
  inspectContainer(id: string): Promise<ContainerInspect>;
  getContainerStats(id: string): Promise<ContainerStats>;
  getContainerLogs(id: string, tail?: number): Promise<string[]>;
  streamContainerLogs(id: string, tail?: number): AsyncIterable<string>;
  pullImage(image: string, onProgress?: callback): Promise<void>;
  hasImage(image: string): Promise<boolean>;
  // ... more
}
```

**Dev mode** uses `MockDockerDriver` — containers live in a `Map<string, MockContainer>`. It generates fake startup logs, periodic heartbeat logs, and simulated stats. No Docker required for development.

**Production** uses `RealDockerDriver` — talks to the Docker socket via `dockerode`.

### Server Lifecycle & Deploy Pipeline

The 9-step deploy state machine ([`deploy.ts`](apps/api/src/servers/deploy.ts)):

| Step | Name | What it does |
|------|------|-------------|
| 1 | `validate` | Validates template & input params |
| 2 | `quota` | Checks user quota + host RAM budget |
| 3 | `ports` | Allocates host ports from `PORT_RANGE` |
| 4 | `volume` | Creates persistent storage directory |
| 5 | `pull` | Pulls Docker image (with progress %) |
| 6 | `create` | Creates hardened container (cgroups, security opts) |
| 7 | `start` | Starts the container |
| 8 | `verify` | Confirms container is running |
| 9 | `done` | Marks server as `running` |

Steps 1-3 run synchronously during `POST /api/servers`. Steps 4-9 run asynchronously with progress streamed via the SSE endpoint `GET /api/servers/:id/deploy-stream`.

A **replay buffer** ensures late-connecting SSE clients receive missed events.

### Game Templates

Templates are defined in [`src/servers/templates.ts`](apps/api/src/servers/templates.ts). Each template specifies:

- Docker image
- Port mappings
- Environment variables (with defaults and secrets)
- Resource defaults/minimums
- Data directory for volume mount
- Stop command and ready-log regex
- RCON configuration (optional)

**Built-in templates:**

| ID | Game | Min RAM | Image |
|----|------|---------|-------|
| `minecraft-java` | Minecraft Java | 1 GB | `itzg/minecraft-server:latest` |
| `minecraft-bedrock` | Minecraft Bedrock | 512 MB | `itzg/minecraft-bedrock-server:latest` |
| `valheim` | Valheim | 2 GB | `lloesche/valheim-server:latest` |
| `palworld` | Palworld | 8 GB | `thijsvanloef/palworld-server-docker:latest` |
| `terraria` | Terraria | 512 MB | `ryshe/terraria:latest` |

### Quota Engine

[`src/servers/quota.ts`](apps/api/src/servers/quota.ts) enforces two layers:

1. **User quotas** — max servers, RAM, CPU, disk per user (from `users` table)
2. **Host budget** — total RAM across all servers capped at `HOST_RAM_BUDGET_PCT` of system RAM

### Diagnosis Engine

[`src/diagnosis/engine.ts`](apps/api/src/diagnosis/engine.ts) automatically inspects:
- Container state (exit codes, OOM kills)
- Recent log patterns (Java crashes, EULA, port conflicts)
- Resource usage

Each rule produces findings with **severity** (`info`/`warn`/`error`), **evidence**, and **actionable one-click fixes**.

### Realtime WebSocket Gateway

[`src/realtime/gateway.ts`](apps/api/src/realtime/gateway.ts) multiplexes on `/ws/servers/:id`:

| Message type | Direction | Description |
|-------------|-----------|-------------|
| `log` | Server → Client | Container log lines (polled every 2s) |
| `stats` | Server → Client | CPU/RAM/PIDs snapshot |
| `status` | Server → Client | Server state changes |
| `command` | Client → Server | Execute a console command |
| `command_ack` | Server → Client | Command result |
| `error` | Server → Client | Permission errors |

Authentication: cookie-based (session cookie is sent with the WS upgrade request).

### Audit Logging

Every **mutation** (create, delete, power action, settings change) must call `writeAudit()`:

```typescript
writeAudit({
  userId: user.id,
  action: 'server.create',
  target: serverId,
  ip: request.ip,
  data: { name, templateId, ramMb },
});
```

---

## Frontend (apps/web)

### Routing & App Shell

[`App.tsx`](apps/web/src/App.tsx) manages client-side routing via state (no react-router):

| View | Component | When shown |
|------|-----------|------------|
| Auth | `AuthModal` | Not logged in |
| Dashboard | `Dashboard` | Logged in, no server selected |
| Server Detail | `ServerView` | Server selected |
| Admin Panel | `AdminView` | Admin clicks "Admin Control" |
| Deploy Wizard | `DeployWizard` | User clicks "Deploy New Server" |

### Components

| Component | File | Purpose |
|-----------|------|---------|
| `AuthModal` | `AuthModal.tsx` | Login/register with setup detection |
| `Dashboard` | `Dashboard.tsx` | Server cards, quota bars, metrics |
| `ServerView` | `ServerView.tsx` | Tabbed server detail (overview, console, debug, settings) |
| `DeployWizard` | `DeployWizard.tsx` | 3-step deploy flow + SSE progress |
| `AdminView` | `AdminView.tsx` | Invite code management, host stats |
| `Toast` | `Toast.tsx` | Toast notification context + renderer |
| `ConfirmModal` | `ConfirmModal.tsx` | Themed confirmation dialog (replaces `window.confirm`) |

### API Client

[`src/api/client.ts`](apps/web/src/api/client.ts) is a typed fetch wrapper:

```typescript
import { api } from '../api/client';

// All methods return typed promises
const servers = await api.listServers();
const server = await api.getServer(id);
await api.startServer(id);
```

Key design:
- Credentials: `same-origin` (cookies sent automatically)
- Errors parsed into `{ code, message, details? }` format
- Non-JSON responses handled gracefully

### Styling System

[`src/index.css`](apps/web/src/index.css) defines the design system using **Tailwind CSS v4** with `@theme static`:

**CSS custom properties** (in `:root`):
- `--color-background`, `--color-foreground`, `--color-primary`, `--color-muted`, `--color-border`, `--color-destructive`, etc.

**Component classes** (in `@layer components`):
- `.card` — glassmorphic card with blur backdrop
- `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost` — button variants
- `.input` — styled form inputs
- `.badge`, `.badge-success`, `.badge-error`, `.badge-warning` — status badges
- `.gradient-text` — animated gradient text
- `.glow-primary` — glowing border effect

---

## API Reference

### Auth Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/auth/setup-status` | No | Check if first-time setup needed |
| `POST` | `/api/auth/register` | No | Register (first user = admin) |
| `POST` | `/api/auth/login` | No | Login (email or username) |
| `POST` | `/api/auth/logout` | Yes | Logout (clears cookie) |
| `GET` | `/api/me` | Yes | Current user profile |

### Server Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/templates` | Yes | List available game templates |
| `GET` | `/api/system/capacity` | Yes | Host + user quota status |
| `GET` | `/api/servers` | Yes | List user's servers |
| `POST` | `/api/servers` | Yes | Deploy new server (9-step) |
| `GET` | `/api/servers/:id` | Yes | Server detail |
| `DELETE` | `/api/servers/:id` | Yes | Delete server permanently |
| `GET` | `/api/servers/:id/events` | Yes | Event timeline |
| `GET` | `/api/servers/:id/deploy-stream` | Yes | SSE deploy progress |
| `GET` | `/api/servers/:id/stats` | Yes | Live CPU/RAM stats |
| `GET` | `/api/servers/:id/diagnose` | Yes | Run diagnosis rules |
| `GET` | `/api/servers/:id/debug-bundle` | Yes | Download debug ZIP |
| `POST` | `/api/servers/:id/start` | Yes | Start server |
| `POST` | `/api/servers/:id/stop` | Yes | Graceful stop |
| `POST` | `/api/servers/:id/restart` | Yes | Restart |
| `POST` | `/api/servers/:id/kill` | Yes | Force kill |
| `POST` | `/api/servers/:id/command` | Yes | Execute console command |
| `POST` | `/api/servers/:id/fixes/apply` | Yes | Apply a diagnosis fix |

### Admin Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/admin/invites` | Admin | List invite codes |
| `POST` | `/api/admin/invites` | Admin | Create invite code |
| `DELETE` | `/api/admin/invites/:id` | Admin | Delete invite |

### WebSocket

| Path | Auth | Description |
|------|------|-------------|
| `/ws/servers/:id` | Cookie | Realtime logs, stats, commands |

### Error Response Format

All errors follow this shape:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid request data.",
  "details": ["name: Server name is required"]
}
```

---

## Testing

Tests live in `apps/api/test/` using **Vitest**. The test helper (`helpers.ts`) provides:

- `createTestApp()` — boots a full Fastify app with MockDockerDriver and in-memory SQLite
- `registerAndLogin()` — creates a user and returns authenticated cookies
- `createTestServer()` — deploys a test server via API

```bash
pnpm test              # Run all 125+ tests
pnpm --filter @vaultrealm/api run test:watch  # Watch mode
```

**Test files:**

| File | What it covers |
|------|----------------|
| `auth.test.ts` | Register, login, logout, invites, cookies |
| `servers.test.ts` | CRUD, power actions, ownership checks |
| `deploy.test.ts` | Full 9-step pipeline, failure handling |
| `rbac.test.ts` | Permissions, sub-users, IDOR protection |
| `quota.test.ts` | User & host quota enforcement |
| `diagnosis.test.ts` | Diagnosis rules with log fixtures |
| `docker-mock.test.ts` | MockDockerDriver behavior |
| `phase3.test.ts` | Console commands, debug bundles |
| `config.test.ts` | Environment validation |
| `sessions.test.ts` | Token signing & verification |
| `rate-limit.test.ts` | Login/register throttling |
| `route-permissions.test.ts` | All routes reject unauthenticated requests |
| `templates.test.ts` | Template registry |
| `database.test.ts` | DB init, migration, schema |

---

## Adding a New Game Template

1. Open [`apps/api/src/servers/templates.ts`](apps/api/src/servers/templates.ts)
2. Add an entry to the `RAW_TEMPLATES` array:

```typescript
{
  id: 'my-game',
  name: 'My Game',
  description: 'My Game dedicated server',
  category: 'Shooter',
  image: 'dockerhub/my-game-server:latest',
  minRamMb: 2048,
  defaultRamMb: 4096,
  defaultCpu: 2,
  defaultDiskMb: 10240,
  ports: [
    { name: 'Game', containerPort: 27015, protocol: 'udp' },
  ],
  env: [
    { key: 'SERVER_NAME', label: 'Server name', default: 'My Server' },
    { key: 'PASSWORD', label: 'Password', default: '', secret: true },
  ],
  dataDir: '/data',
  stopTimeout: 15,
  readyLogRegex: 'Server started',
  readyTimeoutSec: 120,
},
```

3. The Zod schema validates it at startup — you'll get clear errors if fields are missing.
4. Add a test in `test/templates.test.ts`.
5. No frontend changes needed — templates auto-populate the Deploy Wizard.

---

## Adding a New API Route

Every route **must** follow these rules (from `AGENTS.md`):

```typescript
// 1. Validate input with Zod
const parsed = validate(mySchema, request.body, reply);
if (!parsed.success) return;

// 2. Check permissions with can()
const user = getRequestUser(request);
await assertCan(user, 'server:power', serverId);

// 3. Write audit entry for mutations
writeAudit({
  userId: user.id,
  action: 'server.myAction',
  target: serverId,
  ip: request.ip,
  data: { ... },
});

// 4. Return structured errors
throw Object.assign(new Error('Human message'), {
  statusCode: 400,
  code: 'MY_ERROR_CODE',
});
```

Register the route in the appropriate `routes.ts` file. Add a test verifying auth, validation, and behavior.

---

## Adding a Diagnosis Rule

1. Open [`apps/api/src/diagnosis/engine.ts`](apps/api/src/diagnosis/engine.ts)
2. Add a rule to `BUILTIN_RULES`:

```typescript
{
  id: 'my-rule',
  name: 'My Check',
  evaluate: async (ctx) => {
    // ctx has: server, containerState, logs, stats
    if (ctx.logs.some(l => l.includes('FATAL ERROR'))) {
      return {
        ruleId: 'my-rule',
        severity: 'error',
        title: 'Fatal Error Detected',
        explanation: 'The server log contains a fatal error...',
        evidence: ctx.logs.filter(l => l.includes('FATAL')).slice(0, 3),
        fixes: [
          {
            label: 'Restart Server',
            action: { type: 'restart' },
          },
        ],
      };
    }
    return null;
  },
},
```

3. Add a test with a real log fixture in `test/fixtures/`.
4. Every diagnosis rule **must** have a unit test.

---

## Docker & CI/CD

### Local Docker Build

#### 1. Build the Panel and Companion Bot Runner Images

VaultRealm consists of two container images:
1. **`vaultrealm:latest`** — The unified control panel (Fastify API + React frontend).
2. **`vaultrealm/bot-runner:latest`** — The containerized AI companion runner that joins game servers as an autonomous in-game player via Mineflayer.

```bash
# Build the control panel image
docker build -t vaultrealm .

# Build the companion bot runner image
docker build -f apps/bot-runner/Dockerfile -t vaultrealm/bot-runner:latest .
```

You can also run the built-in pnpm workspace scripts:
```bash
# Build both images
pnpm docker:build
pnpm docker:build:bot
```

#### 2. Companion Bot Container Commands

When working directly with the Companion Bot container during development or troubleshooting:

```bash
# Build / rebuild the companion bot container image
docker build -f apps/bot-runner/Dockerfile -t vaultrealm/bot-runner:latest .

# Inspect the bot runner image in Docker
docker images vaultrealm/bot-runner:latest

# Check active companion bot containers
docker ps --filter "label=vaultrealm.bot"

# View live companion bot container logs (CLI)
docker logs -f <container-id-or-name>
# Example:
docker logs -f $(docker ps -q --filter "ancestor=vaultrealm/bot-runner:latest")

# Test run bot container in standalone interactive mode
docker run --rm -it \
  --add-host host.docker.internal:host-gateway \
  -e BOT_ID=dev-bot \
  -e BOT_NAME=Buddy \
  -e SERVER_HOST=host.docker.internal \
  -e SERVER_PORT=25000 \
  -e AUTH_MODE=offline \
  -e WHO_CAN_COMMAND=owner_only \
  -e BOT_TOKEN=mock-token \
  vaultrealm/bot-runner:latest

# Stop and remove all active bot containers
docker rm -f $(docker ps -aq --filter "ancestor=vaultrealm/bot-runner:latest")
```

> [!TIP]
> You can also view live real-time bot container logs directly inside the VaultRealm web panel under **AI Companion -> 📜 Bot Live Logs**.

#### 3. Run the Panel

```bash
docker build -t vaultrealm .
docker run -p 3001:3001 \
  -e PANEL_SECRET=my-secret-key-change-me \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/vaultrealm/data:/srv/vaultrealm/data \
vaultrealm
```

```powershell
docker run -d -p 3001:3001 `
  -e PANEL_SECRET=my-secret-key-change-me `
  -v /var/run/docker.sock:/var/run/docker.sock `
  -v /srv/vaultrealm/data:/srv/vaultrealm/data `
  vaultrealm
```
### Production with Docker Compose

```bash
# Set environment variables
export PANEL_SECRET=your-random-secret
export DOMAIN=panel.yourdomain.com

# Start
docker compose up -d
```

### CI/CD (GitHub Actions)

VaultRealm includes automated container build and publication pipelines:

1. **Docker Hub Publishing** ([`.github/workflows/docker-image.yml`](../.github/workflows/docker-image.yml)):
   - Builds and pushes **VaultRealm** (`hypertextassassin/vaultrealm`)
   - Builds and pushes **AI Companion Bot Runner** (`hypertextassassin/vaultrealm-bot-runner` & `hypertextassassin/bot-runner`)
   - Multi-platform support: `linux/amd64` and `linux/arm64`

2. **GitHub Container Registry (GHCR)** ([`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml)):
   - Publishes `ghcr.io/hypertextassassinrajith/vaultrealm` and `ghcr.io/hypertextassassinrajith/vaultrealm-bot-runner`
   - Generates provenance attestations

**Triggers & Tags**:
- **On push to `master`** → builds and pushes `:edge` and updates `:latest`
- **On version tag `v*`** (e.g. `v0.1.0`) → builds and pushes semver tags (`0.1.0`, `0.1`, `latest`)
- **On PRs to `master`** → builds images to validate compilation without pushing
- Isolated GitHub Actions cache (`type=gha`) per component for fast builds

---

## Code Conventions

### TypeScript

- **Strict mode** — no `any` without a comment explaining why
- **ESM imports** — use `.js` extensions in import paths (e.g., `'./auth/rbac.js'`)
- All exported functions have JSDoc comments

### Git

- Small, focused commits with clear messages
- Always verify: `pnpm lint && pnpm typecheck && pnpm test`
- A task is **not done** until all three pass

### Security

- Player chat is **untrusted input** — authorize every operation
- Never expose Docker socket, raw env secrets, or host paths to the client
- File paths from users must go through `safepath.resolve()`
- Secrets in template env vars are marked `secret: true` and redacted in debug bundles
- All containers run with `no-new-privileges:true` and limited PIDs

### Dependencies

- Keep dependencies minimal
- Justify any new dependency in the commit message
- Prefer built-in Node.js APIs over third-party packages
