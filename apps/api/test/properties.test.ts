import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { buildTestApp, cleanupTestApp, registerAdmin, registerUser, createInvite } from './helpers.js';
import { getServerDataDir } from '../src/servers/volume.js';
import { safepath } from '../src/safepath.js';
import { getDatabase } from '../src/db/index.js';
import { servers, auditLog } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

describe('Server Properties & Minecraft Configuration', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let serverId: string;

  beforeEach(async () => {
    app = await buildTestApp();

    const { cookies } = await registerAdmin(app);
    adminCookie = cookies['vr_session']!;

    // Create a Minecraft server
    const serverRes = await app.inject({
      method: 'POST',
      url: '/api/servers',
      cookies: { vr_session: adminCookie },
      payload: {
        name: 'Properties Test Realm',
        templateId: 'minecraft-java',
        env: {
          TYPE: 'PAPER',
        },
      },
    });
    serverId = serverRes.json().id;
  });

  afterEach(() => {
    cleanupTestApp();
  });

  it('GET /api/servers/:id/properties returns default Minecraft properties when file is absent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/properties`,
      cookies: { vr_session: adminCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isMinecraft).toBe(true);
    expect(body.templateId).toBe('minecraft-java');
    expect(Array.isArray(body.properties)).toBe(true);

    // Verify key properties exist
    const onlineMode = body.properties.find((p: { key: string }) => p.key === 'online-mode');
    expect(onlineMode).toBeDefined();
    expect(onlineMode.value).toBe('true');
    expect(onlineMode.type).toBe('boolean');

    const spawnProtection = body.properties.find((p: { key: string }) => p.key === 'spawn-protection');
    expect(spawnProtection).toBeDefined();
    expect(spawnProtection.value).toBe('16');
    expect(spawnProtection.category).toBe('world');
  });

  it('GET /api/servers/:id/properties reads existing server.properties from disk', async () => {
    const serverDir = getServerDataDir(serverId);
    const propertiesPath = safepath.resolve(serverDir, 'server.properties');

    fs.writeFileSync(
      propertiesPath,
      'online-mode=false\nspawn-protection=32\ndifficulty=hard\ncustom-addon-prop=active\n',
      'utf8',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/properties`,
      cookies: { vr_session: adminCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    const onlineMode = body.properties.find((p: { key: string }) => p.key === 'online-mode');
    expect(onlineMode.value).toBe('false');
    expect(onlineMode.isModified).toBe(true);

    const spawnProt = body.properties.find((p: { key: string }) => p.key === 'spawn-protection');
    expect(spawnProt.value).toBe('32');

    const diff = body.properties.find((p: { key: string }) => p.key === 'difficulty');
    expect(diff.value).toBe('hard');

    const custom = body.properties.find((p: { key: string }) => p.key === 'custom-addon-prop');
    expect(custom).toBeDefined();
    expect(custom.value).toBe('active');
    expect(custom.category).toBe('custom');
  });

  it('POST /api/servers/:id/properties/property updates property one by one and syncs envJson', async () => {
    // 1. Update online-mode to false
    const res = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/properties/property`,
      cookies: { vr_session: adminCookie },
      payload: {
        key: 'online-mode',
        value: 'false',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.key).toBe('online-mode');
    expect(body.value).toBe('false');

    // Verify on disk
    const serverDir = getServerDataDir(serverId);
    const diskContent = fs.readFileSync(safepath.resolve(serverDir, 'server.properties'), 'utf8');
    expect(diskContent).toContain('online-mode=false');

    // Verify database envJson was synced with ONLINE_MODE
    const db = getDatabase();
    const serverRecord = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
    const env = JSON.parse(serverRecord.envJson);
    expect(env.ONLINE_MODE).toBe('false');

    // 2. Update spawn-protection to 0
    const spawnRes = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/properties/property`,
      cookies: { vr_session: adminCookie },
      payload: {
        key: 'spawn-protection',
        value: '0',
      },
    });

    expect(spawnRes.statusCode).toBe(200);
    const diskAfterSpawn = fs.readFileSync(safepath.resolve(serverDir, 'server.properties'), 'utf8');
    expect(diskAfterSpawn).toContain('spawn-protection=0');

    // Verify audit log entry
    const audits = db.select().from(auditLog).where(eq(auditLog.target, serverId)).all();
    const propAudit = audits.find((a) => a.action === 'server.property.update');
    expect(propAudit).toBeDefined();
    expect(propAudit?.dataJson).toContain('online-mode');
  });

  it('POST /api/servers/:id/properties/property validates property key format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/properties/property`,
      cookies: { vr_session: adminCookie },
      payload: {
        key: 'bad key with spaces!@#$',
        value: 'test',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/servers/:id/properties updates properties in batch', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/servers/${serverId}/properties`,
      cookies: { vr_session: adminCookie },
      payload: {
        properties: {
          'online-mode': 'false',
          'spawn-protection': '64',
          'pvp': 'false',
          'motd': 'Welcome to VaultRealm!',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    const serverDir = getServerDataDir(serverId);
    const diskContent = fs.readFileSync(safepath.resolve(serverDir, 'server.properties'), 'utf8');
    expect(diskContent).toContain('online-mode=false');
    expect(diskContent).toContain('spawn-protection=64');
    expect(diskContent).toContain('pvp=false');
    expect(diskContent).toContain('motd=Welcome to VaultRealm!');
  });

  it('POST /api/servers/:id/properties/spawn-point configures world spawn point and protection', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/properties/spawn-point`,
      cookies: { vr_session: adminCookie },
      payload: {
        x: 100,
        y: 64,
        z: -250,
        angle: 90,
        spawnProtection: 24,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/(World spawn set to|Spawn configuration saved)/);

    // Verify spawn-protection in file
    const serverDir = getServerDataDir(serverId);
    const diskContent = fs.readFileSync(safepath.resolve(serverDir, 'server.properties'), 'utf8');
    expect(diskContent).toContain('spawn-protection=24');
  });

  it('enforces RBAC permissions on properties endpoints', async () => {
    // 1. Create invite code for user
    const inviteRes = await createInvite(app, adminCookie);
    const inviteCode = inviteRes.json().code;

    // 2. Register regular user
    const { cookies: userCookies } = await registerUser(
      app,
      inviteCode,
      {
        email: 'outsider@vaultrealm.local',
        username: 'outsider',
      },
    );

    // Try to get properties of admin's server
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/properties`,
      cookies: { vr_session: userCookies['vr_session']! },
    });
    expect(getRes.statusCode).toBe(403);

    // Try to update property
    const updateRes = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/properties/property`,
      cookies: { vr_session: userCookies['vr_session']! },
      payload: {
        key: 'online-mode',
        value: 'false',
      },
    });
    expect(updateRes.statusCode).toBe(403);
  });
});
