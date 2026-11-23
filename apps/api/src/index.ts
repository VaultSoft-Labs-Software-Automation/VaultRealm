import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { loadConfig } from './config.js';
import { initDatabase, runMigrations, closeDatabase } from './db/index.js';
import { authRoutes } from './auth/index.js';
import { serverRoutes, setDockerDriver } from './servers/index.js';
import { backupRoutes } from './backups/routes.js';
import { telegramRoutes } from './telegram/routes.js';
import { startTelegramPolling, stopTelegramPolling } from './telegram/service.js';
import { registerRealtimeGateway } from './realtime/index.js';
import { companionRoutes, botRoutes, registerGateway } from './companion/index.js';
import { registerStatic, isSpaRoute } from './static.js';
import { MockDockerDriver } from './docker/mock.js';
import { RealDockerDriver } from './docker/real.js';

async function main() {
  // ── Load config ────────────────────────────────────────────────────────────
  const config = loadConfig();

  // ── Initialize Fastify with pino logging ───────────────────────────────────
  const app = Fastify({
    trustProxy: true,
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true },
            },
          }
        : {}),
    },
    requestTimeout: 30_000,
  });

  // ── Plugins ────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
  });

  await app.register(cookie, {
    secret: config.PANEL_SECRET,
  });

  // ── Database ───────────────────────────────────────────────────────────────
  initDatabase();
  runMigrations();
  app.log.info('Database initialized');

  // ── Health endpoint ────────────────────────────────────────────────────────
  app.get('/healthz', async () => {
    return {
      status: 'ok',
      version: '0.1.0',
      uptime: process.uptime(),
    };
  });

  // ── Docker driver ────────────────────────────────────────────────────────
  if (config.NODE_ENV === 'production') {
    setDockerDriver(new RealDockerDriver());
    app.log.info('Using real Docker driver');
  } else {
    setDockerDriver(new MockDockerDriver());
    app.log.info('Using mock Docker driver (development)');
  }

  // ── Routes & Realtime ───────────────────────────────────────────────────────
  await app.register(websocket);
  await registerRealtimeGateway(app);
  await app.register(authRoutes);
  await app.register(serverRoutes);
  await app.register(companionRoutes);
  await app.register(botRoutes);
  await app.register(backupRoutes);
  await app.register(telegramRoutes);
  await registerGateway(app);

  // ── Static frontend assets (production / built web) ───────────────────────
  const hasStatic = await registerStatic(app);
  if (hasStatic) {
    app.log.info('Serving static frontend assets');
  } else {
    app.log.info('Static frontend assets not found; running in API-only mode');
  }

  // ── Error handler ──────────────────────────────────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string; issues?: Array<{ path: (string | number)[]; message: string }> }, _request, reply) => {
    // Handle Zod validation errors
    if (error.name === 'ZodError' && error.issues) {
      const messages = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data.',
        details: messages,
      });
    }

    const statusCode = error.statusCode ?? 500;
    const response = {
      code: error.code ?? 'INTERNAL_ERROR',
      message: error.message,
      ...(config.NODE_ENV === 'development' ? { stack: error.stack } : {}),
    };

    app.log.error({ err: error, statusCode }, 'Request error');
    return reply.status(statusCode).send(response);
  });

  // ── 404 handler & SPA fallback ─────────────────────────────────────────────
  app.setNotFoundHandler((request, reply) => {
    if (hasStatic && isSpaRoute(request.method, request.url)) {
      return reply.sendFile('index.html');
    }

    return reply.status(404).send({
      code: 'NOT_FOUND',
      message: 'Route not found',
    });
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down...`);
    stopTelegramPolling();
    await app.close();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // ── Start ──────────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`VaultRealm API running on port ${config.PORT}`);
    // Start Telegram long polling if configured and enabled
    startTelegramPolling();
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }
}

main();
