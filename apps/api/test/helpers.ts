/**
 * Test helper — creates a fully configured Fastify app for integration tests.
 *
 * Uses an in-memory SQLite database and isolated config per test.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { loadConfig, resetConfig } from '../src/config.js';
import { initDatabase, runMigrations, closeDatabase } from '../src/db/index.js';
import { authRoutes } from '../src/auth/index.js';
import { serverRoutes, setDockerDriver } from '../src/servers/index.js';
import { registerRealtimeGateway } from '../src/realtime/index.js';
import { companionRoutes, botRoutes, registerGateway } from '../src/companion/index.js';
import { backupRoutes } from '../src/backups/routes.js';
import { MockDockerDriver } from '../src/docker/mock.js';
import { resetRateLimits } from '../src/auth/rate-limit.js';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let testDir: string;

/**
 * Build a test Fastify app with all routes registered.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  testDir = join(tmpdir(), `vaultrealm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });

  loadConfig({
    PANEL_SECRET: 'test-secret-at-least-16-chars',
    DATA_DIR: testDir,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
  });

  const app = Fastify({ logger: false });

  await app.register(cookie, {
    secret: 'test-secret-at-least-16-chars',
  });

  initDatabase();
  runMigrations();

  // Docker driver (mock for tests)
  setDockerDriver(new MockDockerDriver());

  // Health endpoint
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Routes & Realtime
  await app.register(websocket);
  await registerRealtimeGateway(app);
  await app.register(authRoutes);
  await app.register(serverRoutes);
  await app.register(companionRoutes);
  await app.register(botRoutes);
  await app.register(backupRoutes);
  await registerGateway(app);

  // Error handler (same as production)
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string; issues?: Array<{ path: (string | number)[]; message: string }> }, _request, reply) => {
    if (error.name === 'ZodError' && error.issues) {
      const messages = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data.',
        details: messages,
      });
    }

    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      code: error.code ?? 'INTERNAL_ERROR',
      message: error.message,
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      code: 'NOT_FOUND',
      message: 'Route not found',
    });
  });

  await app.ready();
  return app;
}

/**
 * Clean up test resources.
 */
export function cleanupTestApp(): void {
  closeDatabase();
  resetConfig();
  resetRateLimits();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
}

/**
 * Helper to register the first user (admin).
 */
export async function registerAdmin(app: FastifyInstance) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'admin@test.com',
      username: 'admin',
      password: 'password123!',
    },
  });
  const cookies = parseCookies(res.headers['set-cookie']);
  return { response: res, cookies };
}

/**
 * Helper to register a regular user (requires invite).
 */
export async function registerUser(
  app: FastifyInstance,
  inviteCode: string,
  overrides?: { email?: string; username?: string },
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: overrides?.email ?? 'user@test.com',
      username: overrides?.username ?? 'testuser',
      password: 'password123!',
      inviteCode,
    },
  });
  const cookies = parseCookies(res.headers['set-cookie']);
  return { response: res, cookies };
}

/**
 * Helper to login.
 */
export async function loginUser(
  app: FastifyInstance,
  login: string,
  password = 'password123!',
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login, password },
  });
  const cookies = parseCookies(res.headers['set-cookie']);
  return { response: res, cookies };
}

/**
 * Helper to create an invite (must be admin).
 */
export async function createInvite(
  app: FastifyInstance,
  adminCookie: string,
  opts?: { maxUses?: number },
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/invites',
    payload: { maxUses: opts?.maxUses ?? 10 },
    cookies: { vr_session: adminCookie },
  });
  return res;
}

/**
 * Parse Set-Cookie header to extract cookie values.
 */
export function parseCookies(setCookieHeader: string | string[] | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!setCookieHeader) return cookies;

  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    const [nameValue] = header.split(';');
    if (nameValue) {
      const eqIdx = nameValue.indexOf('=');
      if (eqIdx > 0) {
        const name = nameValue.slice(0, eqIdx).trim();
        const value = nameValue.slice(eqIdx + 1).trim();
        cookies[name] = value;
      }
    }
  }
  return cookies;
}
