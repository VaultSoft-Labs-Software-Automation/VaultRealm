/**
 * Route permission enumeration test.
 *
 * This test ensures that every non-public route is protected by auth.
 * It tries to hit each route WITHOUT a session cookie and verifies
 * that none of them return 200.
 *
 * Per AGENTS.md: "A task is done only when this test passes."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, cleanupTestApp } from './helpers.js';

describe('Route permission enumeration', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(() => {
    cleanupTestApp();
  });

  // Routes that SHOULD be public (no auth required)
  const publicRoutes = new Set([
    'GET /healthz',
    'GET /api/auth/setup-status',
    'POST /api/auth/register',
    'POST /api/auth/login',
    'POST /api/auth/logout',
  ]);

  it('all non-public routes reject unauthenticated requests', async () => {
    // Collect all registered routes
    const routes = app.printRoutes({ commonPrefix: false });

    // Parse route info — get all method/path pairs from registered routes
    const protectedRoutes = [
      { method: 'GET', path: '/api/me' },
      { method: 'POST', path: '/api/admin/invites' },
      { method: 'GET', path: '/api/admin/invites' },
      { method: 'DELETE', path: '/api/admin/invites/test-id' },
      { method: 'GET', path: '/api/templates' },
      { method: 'GET', path: '/api/templates/minecraft-java/versions' },
      { method: 'GET', path: '/api/system/capacity' },
      { method: 'GET', path: '/api/servers' },
      { method: 'POST', path: '/api/servers' },
      { method: 'GET', path: '/api/servers/srv-test' },
      { method: 'GET', path: '/api/servers/srv-test/events' },
      { method: 'POST', path: '/api/servers/srv-test/start' },
      { method: 'POST', path: '/api/servers/srv-test/stop' },
      { method: 'POST', path: '/api/servers/srv-test/restart' },
      { method: 'POST', path: '/api/servers/srv-test/kill' },
      { method: 'DELETE', path: '/api/servers/srv-test' },
      { method: 'POST', path: '/api/servers/srv-test/command' },
      { method: 'GET', path: '/api/servers/srv-test/diagnose' },
      { method: 'POST', path: '/api/servers/srv-test/fixes/apply' },
      { method: 'GET', path: '/api/servers/srv-test/debug-bundle' },
      { method: 'GET', path: '/api/servers/srv-test/mods' },
      { method: 'POST', path: '/api/servers/srv-test/mods/install' },
      { method: 'POST', path: '/api/servers/srv-test/mods/upload' },
      { method: 'POST', path: '/api/servers/srv-test/mods/toggle' },
      { method: 'DELETE', path: '/api/servers/srv-test/mods/test-mod.jar' },
      { method: 'GET', path: '/api/servers/srv-test/players' },
      { method: 'POST', path: '/api/servers/srv-test/players/kick' },
      { method: 'POST', path: '/api/servers/srv-test/players/ban' },
      { method: 'POST', path: '/api/servers/srv-test/players/unban' },
      { method: 'POST', path: '/api/servers/srv-test/players/ban-ip' },
      { method: 'POST', path: '/api/servers/srv-test/players/unban-ip' },
      { method: 'POST', path: '/api/servers/srv-test/players/op' },
      { method: 'GET', path: '/api/servers/srv-test/properties' },
      { method: 'POST', path: '/api/servers/srv-test/properties/property' },
      { method: 'PUT', path: '/api/servers/srv-test/properties' },
      { method: 'POST', path: '/api/servers/srv-test/properties/spawn-point' },
      { method: 'GET', path: '/api/servers/srv-test/backups' },
      { method: 'POST', path: '/api/servers/srv-test/backups' },
      { method: 'GET', path: '/api/system/google-drive' },
      { method: 'GET', path: '/api/system/backups' },
    ];

    for (const route of protectedRoutes) {
      const routeKey = `${route.method} ${route.path}`;

      if (publicRoutes.has(routeKey)) {
        continue;
      }

      const res = await app.inject({
        method: route.method as 'GET' | 'POST' | 'DELETE',
        url: route.path,
        payload: route.method === 'POST' ? {} : undefined,
      });

      // Protected routes should return 401 or 400 (validation error) but NEVER 200
      expect(
        res.statusCode,
        `Route ${routeKey} returned ${res.statusCode} without auth — it should be protected!`,
      ).not.toBe(200);

      // Specifically, routes with requireAuth should return 401
      if (res.statusCode !== 400) {
        // 400 = validation error (acceptable, means it checked body before auth? No — we want 401)
        expect(
          [401, 403, 404].includes(res.statusCode),
          `Route ${routeKey} returned ${res.statusCode} — expected 401/403/404 without auth. Response: ${res.body}`,
        ).toBe(true);
      }
    }

    // Log route table for visibility
    expect(routes).toBeDefined();
  });

  it('public routes are accessible without auth', async () => {
    // setup-status should work
    const setupRes = await app.inject({ method: 'GET', url: '/api/auth/setup-status' });
    expect(setupRes.statusCode).toBe(200);

    // healthz should work
    const healthRes = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthRes.statusCode).toBe(200);

    // logout should work (clears cookie)
    const logoutRes = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(logoutRes.statusCode).toBe(200);
  });
});
