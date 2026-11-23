import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  cleanupTestApp,
  registerAdmin,
  registerUser,
  createInvite,
} from './helpers.js';

describe('Server lifecycle', () => {
  let app: FastifyInstance;
  let adminCookie: string;

  beforeEach(async () => {
    app = await buildTestApp();
    const { cookies } = await registerAdmin(app);
    adminCookie = cookies['vr_session']!;
  });

  afterEach(() => {
    cleanupTestApp();
  });

  // ── Templates ──────────────────────────────────────────────────────────────
  describe('GET /api/templates', () => {
    it('returns available templates', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/templates',
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      const templates = res.json();
      expect(templates.length).toBeGreaterThanOrEqual(5);

      const minecraft = templates.find((t: { id: string }) => t.id === 'minecraft-java');
      expect(minecraft).toBeDefined();
      expect(minecraft.name).toBe('Minecraft Java');
      expect(minecraft.ports).toHaveLength(2); // game + rcon
    });

    it('does not expose secret env vars', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/templates',
        cookies: { vr_session: adminCookie },
      });

      const templates = res.json();
      const minecraft = templates.find((t: { id: string }) => t.id === 'minecraft-java');
      const rconEnv = minecraft.env.find((e: { key: string }) => e.key === 'RCON_PASSWORD');
      expect(rconEnv).toBeUndefined();
    });

    it('requires auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/templates' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Create ─────────────────────────────────────────────────────────────────
  describe('POST /api/servers', () => {
    it('creates a server from template', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: {
          name: 'My Minecraft',
          templateId: 'minecraft-java',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeTruthy();
      expect(body.name).toBe('My Minecraft');
      expect(body.status).toBe('creating');
    });

    it('rejects invalid template', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: {
          name: 'Test',
          templateId: 'fake-game',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_TEMPLATE');
    });

    it('rejects missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: {
          templateId: 'minecraft-java',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('requires auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers',
        payload: { name: 'Test', templateId: 'minecraft-java' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── List ───────────────────────────────────────────────────────────────────
  describe('GET /api/servers', () => {
    it('returns user servers', async () => {
      // Create a server first
      await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: { name: 'Test Server', templateId: 'minecraft-java' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      const servers = res.json();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('Test Server');
      expect(servers[0].ports).toHaveLength(2); // minecraft has game + rcon ports
    });

    it('user only sees own servers', async () => {
      // Admin creates a server
      await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: { name: 'Admin Server', templateId: 'minecraft-java' },
      });

      // Create regular user
      const inviteRes = await createInvite(app, adminCookie);
      const inviteCode = inviteRes.json().code;
      const { cookies: userCookies } = await registerUser(app, inviteCode);

      // User should see 0 servers
      const res = await app.inject({
        method: 'GET',
        url: '/api/servers',
        cookies: { vr_session: userCookies['vr_session']! },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(0);
    });
  });

  // ── View ───────────────────────────────────────────────────────────────────
  describe('GET /api/servers/:id', () => {
    it('returns server detail', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: { name: 'My MC', templateId: 'minecraft-java' },
      });
      const serverId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}`,
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      const detail = res.json();
      expect(detail.id).toBe(serverId);
      expect(detail.templateName).toBe('Minecraft Java');
      expect(detail.ramMb).toBe(2048); // default
      expect(detail.ports).toHaveLength(2);
    });

    it('non-owner cannot view server', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: { name: 'Private', templateId: 'minecraft-java' },
      });
      const serverId = createRes.json().id;

      // Create regular user
      const inviteRes = await createInvite(app, adminCookie);
      const { cookies: userCookies } = await registerUser(app, inviteRes.json().code);

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}`,
        cookies: { vr_session: userCookies['vr_session']! },
      });

      // Admin can see all servers (admin bypass), but non-owner regular user cannot
      expect(res.statusCode).toBe(403);
    });
  });

  // ── Power actions (with mock driver) ───────────────────────────────────────
  describe('Power actions', () => {
    let serverId: string;

    beforeEach(async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: { name: 'Power Test', templateId: 'minecraft-java' },
      });
      serverId = createRes.json().id;
    });

    it('start server', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/start`,
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().message).toContain('starting');

      // Verify status updated
      const detail = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}`,
        cookies: { vr_session: adminCookie },
      });
      expect(detail.json().status).toBe('running');
    });

    it('stop server', async () => {
      // Start first
      await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/start`,
        cookies: { vr_session: adminCookie },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/stop`,
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
    });

    it('restart server', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/restart`,
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns server resource metrics including CPU, RAM, network, PIDs, and disk', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/start`,
        cookies: { vr_session: adminCookie },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/stats`,
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      const stats = res.json();
      expect(typeof stats.cpuPercent).toBe('number');
      expect(typeof stats.memoryUsageMb).toBe('number');
      expect(typeof stats.memoryLimitMb).toBe('number');
      expect(typeof stats.networkRxBytes).toBe('number');
      expect(typeof stats.networkTxBytes).toBe('number');
      expect(typeof stats.pids).toBe('number');
      expect(typeof stats.diskUsedMb).toBe('number');
      expect(typeof stats.diskLimitMb).toBe('number');
    });

    it('non-owner cannot start server', async () => {
      const inviteRes = await createInvite(app, adminCookie);
      const { cookies: userCookies } = await registerUser(app, inviteRes.json().code);

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/start`,
        cookies: { vr_session: userCookies['vr_session']! },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ── Delete ─────────────────────────────────────────────────────────────────
  describe('DELETE /api/servers/:id', () => {
    it('owner can delete server', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: { name: 'To Delete', templateId: 'minecraft-java' },
      });
      const serverId = createRes.json().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}`,
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);

      // Verify it's gone
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
      });
      expect(listRes.json()).toHaveLength(0);
    });

    it('non-owner cannot delete server', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: { name: 'Protected', templateId: 'minecraft-java' },
      });
      const serverId = createRes.json().id;

      const inviteRes = await createInvite(app, adminCookie);
      const { cookies: userCookies } = await registerUser(app, inviteRes.json().code);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}`,
        cookies: { vr_session: userCookies['vr_session']! },
      });

      expect(res.statusCode).toBe(403);
    });

    it('owner can delete server with companion bot and child records without FK errors', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
        payload: { name: 'Server With Bot', templateId: 'minecraft-java' },
      });
      const serverId = createRes.json().id;

      // Create an endpoint & companion bot record for this server
      const epRes = await app.inject({
        method: 'POST',
        url: '/api/llm-endpoints',
        cookies: { vr_session: adminCookie },
        payload: {
          name: 'Test Endpoint',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test-key-123',
        },
      });
      const endpointId = epRes.json().id;

      // Update companion bot configuration for server
      await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/companion/bot`,
        cookies: { vr_session: adminCookie },
        payload: {
          endpointId,
          name: 'Buddy',
          persona: 'helpful friend',
          authMode: 'offline',
          spawnMode: 'manual',
          whoCanCommand: 'owner_only',
        },
      });

      // Now delete the server
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}`,
        cookies: { vr_session: adminCookie },
      });

      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.json().message).toBe('Server deleted.');

      const listRes = await app.inject({
        method: 'GET',
        url: '/api/servers',
        cookies: { vr_session: adminCookie },
      });
      expect(listRes.json()).toHaveLength(0);
    });
  });
});
