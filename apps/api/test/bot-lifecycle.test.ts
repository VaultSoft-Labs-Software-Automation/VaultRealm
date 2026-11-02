import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import {
  buildTestApp,
  cleanupTestApp,
  registerAdmin,
  registerUser,
  createInvite,
} from './helpers.js';
import { getDatabase } from '../src/db/index.js';
import { servers, serverPorts, bots, llmEndpoints, events, auditLog } from '../src/db/schema.js';
import { getDockerDriver } from '../src/servers/service.js';
import type { ContainerCreateOptions } from '../src/docker/driver.js';
import { eq } from 'drizzle-orm';

describe('Phase 6b — Bot Runner Lifecycle & Management Routes', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let userCookie: string;
  let userId: string;
  let serverId: string;
  let endpointId: string;

  beforeEach(async () => {
    app = await buildTestApp();
    const admin = await registerAdmin(app);
    adminCookie = admin.cookies['vr_session']!;

    const inviteRes = await createInvite(app, adminCookie);
    const inviteCode = inviteRes.json().code;
    const user = await registerUser(app, inviteCode, {
      username: 'botowner',
      email: 'botowner@test.com',
    });
    userCookie = user.cookies['vr_session']!;
    userId = user.response.json().id;

    const db = getDatabase();

    // Create an LLM endpoint
    endpointId = nanoid();
    db.insert(llmEndpoints).values({
      id: endpointId,
      ownerId: userId,
      scope: 'user',
      name: 'Owner Endpoint',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
      timeoutS: 30,
    }).run();

    // Create a game server
    serverId = nanoid();
    db.insert(servers).values({
      id: serverId,
      ownerId: userId,
      name: 'Survival Server',
      templateId: 'minecraft-java',
      status: 'stopped',
      ramMb: 2048,
      containerId: `container-${serverId}`,
      createdAt: new Date().toISOString(),
    }).run();

    db.insert(serverPorts).values({
      id: nanoid(),
      serverId,
      name: 'game',
      hostPort: 25565,
      containerPort: 25565,
      protocol: 'tcp',
    }).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTestApp();
  });

  // ── 1. Bot Configuration (GET & PUT) ───────────────────────────────────────
  describe('Bot configuration', () => {
    it('returns configured: false when no bot exists for the server', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/companion/bot`,
        cookies: { vr_session: userCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
      expect(res.json().bot).toBeNull();
    });

    it('creates bot configuration on PUT', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/companion/bot`,
        cookies: { vr_session: userCookie },
        payload: {
          endpointId,
          name: 'BuddyGuard',
          persona: 'expert survival helper',
          mode: 'manual',
          authMode: 'offline',
          whoCanCommand: 'owner',
          dailyTokenBudget: 150000,
          rpmLimit: 20,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.id).toBeDefined();
      expect(data.name).toBe('BuddyGuard');
      expect(data.status).toBe('offline');

      // Verify GET returns the newly configured bot
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/companion/bot`,
        cookies: { vr_session: userCookie },
      });

      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.json();
      expect(getBody.configured).toBe(true);
      expect(getBody.bot.name).toBe('BuddyGuard');
      expect(getBody.bot.persona).toBe('expert survival helper');
      expect(getBody.bot.authMode).toBe('offline');
      expect(getBody.bot.dailyTokenBudget).toBe(150000);
    });

    it('rejects bot configuration with invalid endpoint', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/companion/bot`,
        cookies: { vr_session: userCookie },
        payload: {
          endpointId: 'non-existent-endpoint',
          name: 'Buddy',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('ENDPOINT_NOT_FOUND');
    });

    it('enforces RBAC permissions on bot configuration', async () => {
      // Unauthenticated
      const unauthRes = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/companion/bot`,
      });
      expect(unauthRes.statusCode).toBe(401);

      // Create a second user who is not a member of the server
      const inviteRes = await createInvite(app, adminCookie);
      const otherUser = await registerUser(app, inviteRes.json().code, {
        username: 'stranger',
        email: 'stranger@test.com',
      });
      const otherCookie = otherUser.cookies['vr_session']!;

      const forbiddenRes = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/companion/bot`,
        cookies: { vr_session: otherCookie },
        payload: {
          endpointId,
          name: 'HackedBot',
        },
      });
      expect(forbiddenRes.statusCode).toBe(403);
    });
  });

  // ── 2. Spawn and Despawn Lifecycle ─────────────────────────────────────────
  describe('Bot spawn and despawn lifecycle', () => {
    beforeEach(async () => {
      // Configure bot first
      await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/companion/bot`,
        cookies: { vr_session: userCookie },
        payload: {
          endpointId,
          name: 'ActiveBuddy',
          persona: 'helpful buddy',
          mode: 'manual',
        },
      });
    });

    it('rejects spawn if server is not running', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/companion/bot/spawn`,
        cookies: { vr_session: userCookie },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('SERVER_NOT_RUNNING');
    });

    it('spawns the bot container when server is running', async () => {
      const db = getDatabase();
      // Set server status to running
      db.update(servers).set({ status: 'running' }).where(eq(servers.id, serverId)).run();

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/companion/bot/spawn`,
        cookies: { vr_session: userCookie },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe('joining');
      expect(data.containerId).toBeDefined();

      // Verify DB bot state
      const botRows = db.select().from(bots).where(eq(bots.serverId, serverId)).all();
      expect(botRows[0]!.status).toBe('joining');
      expect(botRows[0]!.containerId).toBe(data.containerId);
      expect(botRows[0]!.lastSpawnedAt).toBeDefined();

      // Verify event was recorded
      const eventRows = db.select().from(events).where(eq(events.serverId, serverId)).all();
      const spawnEvent = eventRows.find((e) => e.kind === 'bot.spawn');
      expect(spawnEvent).toBeDefined();
      expect(spawnEvent?.message).toContain('ActiveBuddy');

      // Verify audit log
      const audits = db.select().from(auditLog).where(eq(auditLog.action, 'bot.spawn')).all();
      expect(audits.length).toBe(1);
    });

    it('resolves direct container IP and configures extraHosts for Docker bridge networking', async () => {
      const db = getDatabase();
      db.update(servers).set({ status: 'running' }).where(eq(servers.id, serverId)).run();

      const driver = getDockerDriver();
      let capturedCreateOpts: ContainerCreateOptions | null = null;
      const origCreateContainer = driver.createContainer.bind(driver);
      driver.createContainer = async (opts) => {
        capturedCreateOpts = opts;
        return origCreateContainer(opts);
      };

      // Temporarily toggle isMock flag on driver instance to verify bridge networking resolution logic
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- override readonly isMock property on test driver instance
      (driver as any).isMock = false;
      const origInspect = driver.inspectContainer.bind(driver);
      driver.inspectContainer = async (id: string) => {
        if (id === `container-${serverId}`) {
          return {
            id,
            name: `/${id}`,
            state: { status: 'running', running: true, exitCode: 0, oomKilled: false, startedAt: '', finishedAt: '', error: '' },
            image: 'itzg/minecraft-server',
            config: { env: [], labels: {} },
            hostConfig: { memory: 0, nanoCpus: 0, pidsLimit: 0, restartPolicy: { name: 'no', maximumRetryCount: 0 } },
            networkSettings: {
              ports: { '25565/tcp': [{ HostPort: '25000' }] },
              ipAddress: '172.17.0.2',
              gateway: '172.17.0.1',
            },
            mounts: [],
          };
        }
        return origInspect(id);
      };

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/companion/bot/spawn`,
        cookies: { vr_session: userCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(capturedCreateOpts).toBeDefined();
      // Verifies direct bridge connection to container IP & container port
      expect(capturedCreateOpts.env.SERVER_HOST).toBe('172.17.0.2');
      expect(capturedCreateOpts.env.SERVER_PORT).toBe('25565');
      // Verifies extraHosts includes host-gateway mapping for Linux Docker hosts
      expect(capturedCreateOpts.extraHosts).toContain('host.docker.internal:host-gateway');
      expect(capturedCreateOpts.extraHosts).toContain('host.docker.internal:172.17.0.1');
    });

    it('automatically pulls bot runner image when missing before creating container', async () => {
      const db = getDatabase();
      db.update(servers).set({ status: 'running' }).where(eq(servers.id, serverId)).run();

      const driver = getDockerDriver();
      const pulledImages: string[] = [];
      const origPullImage = driver.pullImage.bind(driver);
      driver.pullImage = async (image: string) => {
        pulledImages.push(image);
        return origPullImage(image);
      };

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/companion/bot/spawn`,
        cookies: { vr_session: userCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(pulledImages.length).toBeGreaterThanOrEqual(1);
      expect(pulledImages[0]).toContain('bot-runner');
    });

    it('rejects duplicate spawn if bot is already active', async () => {
      const db = getDatabase();
      db.update(servers).set({ status: 'running' }).where(eq(servers.id, serverId)).run();

      // First spawn
      await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/companion/bot/spawn`,
        cookies: { vr_session: userCookie },
      });

      // Second spawn attempt
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/companion/bot/spawn`,
        cookies: { vr_session: userCookie },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('BOT_ALREADY_SPAWNED');
    });

    it('despawns the bot container and transitions status to offline', async () => {
      const db = getDatabase();
      db.update(servers).set({ status: 'running' }).where(eq(servers.id, serverId)).run();

      // Spawn first
      const spawnRes = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/companion/bot/spawn`,
        cookies: { vr_session: userCookie },
      });
      expect(spawnRes.statusCode).toBe(200);

      // Despawn
      const despawnRes = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/companion/bot/despawn`,
        cookies: { vr_session: userCookie },
      });

      expect(despawnRes.statusCode).toBe(200);
      expect(despawnRes.json().success).toBe(true);
      expect(despawnRes.json().status).toBe('offline');

      // Verify DB bot state
      const botRows = db.select().from(bots).where(eq(bots.serverId, serverId)).all();
      expect(botRows[0]!.status).toBe('offline');
      expect(botRows[0]!.containerId).toBeNull();
      expect(botRows[0]!.lastDespawnedAt).toBeDefined();

      // Verify despawn event
      const eventRows = db.select().from(events).where(eq(events.serverId, serverId)).all();
      const despawnEvent = eventRows.find((e) => e.kind === 'bot.despawn');
      expect(despawnEvent).toBeDefined();
    });
  });

  // ── 3. Quick Companion Action ──────────────────────────────────────────────
  describe('Companion quick action', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/companion/bot`,
        cookies: { vr_session: userCookie },
        payload: { endpointId, name: 'CommandBuddy' },
      });
    });

    it('executes quick command action and records audit entry', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/companion/bot/action`,
        cookies: { vr_session: userCookie },
        payload: { action: 'stop' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().action).toBe('stop');

      const db = getDatabase();
      const audits = db.select().from(auditLog).where(eq(auditLog.action, 'bot.action')).all();
      expect(audits.length).toBe(1);
    });
  });
});
