/**
 * Server routes — CRUD, power actions, deploy streaming, events, console, and debugging.
 *
 * Every route validates with zod, calls can() for permissions,
 * and writes an audit entry for mutations (AGENTS.md rules).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { requireAuth, getRequestUser } from '../auth/middleware.js';
import { assertCan } from '../auth/rbac.js';
import { validate } from '../validation.js';
import { getAllTemplates } from './templates.js';
import { getTemplateVersions } from './versions.js';
import {
  listInstalledMods,
  installModFromUrl,
  toggleMod,
  deleteMod,
  getAddonsFolder,
  detectServerGameVersion,
  saveUploadedMod,
  getInstalledModpack,
} from './mods.js';
import {
  getServerPlayersData,
  kickPlayer,
  banPlayer,
  unbanPlayer,
  banIp,
  unbanIp,
  setPlayerOp,
} from './players.js';
import {
  getServerPropertiesData,
  updateServerProperty,
  updateServerPropertiesBatch,
  setServerWorldSpawn,
} from './properties.js';
import { writeAudit } from '../audit/log.js';
import {
  startServer,
  stopServer,
  restartServer,
  killServer,
  deleteServer,
  getServerDetail,
  listUserServers,
  getDockerDriver,
} from './service.js';
import { executeDeploy, subscribeDeployProgress, getDeployHistory } from './deploy.js';
import { getHostCapacityStatus, getUserQuotaUsage } from './quota.js';
import { getDatabase } from '../db/index.js';
import { events } from '../db/schema.js';
import { diagnoseServer, applyDiagnosisFix, type FixAction } from '../diagnosis/index.js';
import { generateDebugBundle } from './debug-bundle.js';
import { executeServerCommand } from './console.js';
import { getServerDiskUsage } from './volume.js';

// ── Validation schemas ───────────────────────────────────────────────────────

const createServerSchema = z.object({
  name: z
    .string()
    .min(1, 'Server name is required')
    .max(64, 'Server name must be at most 64 characters'),
  templateId: z.string().min(1, 'Template ID is required'),
  ramMb: z.number().int().min(256).max(65536).optional(),
  cpuLimit: z.number().int().min(1).max(16).optional(),
  diskLimitMb: z.number().int().min(512).max(204800).optional(),
  env: z.record(z.string()).optional(),
});

const commandSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
});

const applyFixSchema = z.object({
  action: z.object({
    type: z.enum([
      'set-env',
      'raise-ram',
      'change-port',
      'restart',
      'open-docs',
      'chown-volume',
      'clean-disk',
    ]),
    payload: z.record(z.unknown()).optional(),
  }),
});

const installModSchema = z.object({
  downloadUrl: z.string().url('Must be a valid URL'),
  filename: z.string().min(1).max(255),
  projectId: z.string().optional(),
  title: z.string().optional(),
});

const toggleModSchema = z.object({
  filename: z.string().min(1).max(255),
  enable: z.boolean(),
});

const uploadModSchema = z.object({
  filename: z.string().min(1).max(255),
  contentBase64: z.string().min(1, 'File content cannot be empty'),
});

const kickPlayerSchema = z.object({
  player: z.string().min(1, 'Player name is required').max(64),
  reason: z.string().max(255).optional(),
});

const banPlayerSchema = z.object({
  player: z.string().min(1, 'Player name is required').max(64),
  reason: z.string().max(255).optional(),
});

const unbanPlayerSchema = z.object({
  player: z.string().min(1, 'Player name is required').max(64),
});

const banIpSchema = z.object({
  ipOrPlayer: z.string().min(1, 'IP address or player name is required').max(64),
  reason: z.string().max(255).optional(),
});

const unbanIpSchema = z.object({
  ip: z.string().min(1, 'IP address is required').max(64),
});

const setOpSchema = z.object({
  player: z.string().min(1, 'Player name is required').max(64),
  op: z.boolean(),
});

const updatePropertySchema = z.object({
  key: z
    .string()
    .min(1, 'Property key is required')
    .max(128, 'Property key is too long')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Property key contains invalid characters'),
  value: z.string().max(2048, 'Property value is too long'),
});

const updatePropertiesBatchSchema = z.object({
  properties: z.record(z.string()).optional(),
  rawContent: z.string().max(65536, 'Content exceeds maximum file size').optional(),
});

const setSpawnPointSchema = z.object({
  x: z.number({ required_error: 'X coordinate is required' }),
  y: z.number({ required_error: 'Y coordinate is required' }),
  z: z.number({ required_error: 'Z coordinate is required' }),
  angle: z.number().optional(),
  spawnProtection: z.number().int().min(0).max(100000).optional(),
});

// ── Route registration ───────────────────────────────────────────────────────

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/templates ─────────────────────────────────────────────────────
  app.get('/api/templates', { preHandler: [requireAuth] }, async () => {
    return getAllTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      minRamMb: t.minRamMb,
      defaultRamMb: t.defaultRamMb,
      defaultCpu: t.defaultCpu,
      defaultDiskMb: t.defaultDiskMb,
      ports: t.ports,
      env: t.env.filter((e) => !e.secret).map((e) => ({
        key: e.key,
        label: e.label,
        default: e.default,
        required: e.required,
        description: e.description,
        options: e.options,
      })),
    }));
  });

  // ── GET /api/templates/:templateId/versions ────────────────────────────────
  app.get('/api/templates/:templateId/versions', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    await assertCan(user, 'server:create');

    const params = request.params as { templateId: string };
    const templateId = params.templateId;
    if (!templateId) {
      return reply.status(400).send({
        code: 'INVALID_TEMPLATE',
        message: 'Template ID is required.',
      });
    }

    const versions = await getTemplateVersions(templateId);
    return versions;
  });

  // ── GET /api/system/capacity ───────────────────────────────────────────────
  app.get('/api/system/capacity', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    return {
      host: getHostCapacityStatus(),
      user: getUserQuotaUsage(user.id),
    };
  });

  // ── GET /api/servers ───────────────────────────────────────────────────────
  app.get('/api/servers', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    await assertCan(user, 'server:list');
    return listUserServers(user.id);
  });

  // ── POST /api/servers (One-click 9-step deploy) ─────────────────────────────
  app.post('/api/servers', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    await assertCan(user, 'server:create');

    const parsed = validate(createServerSchema, request.body, reply);
    if (!parsed.success) return;

    const result = await executeDeploy(user, {
      ...parsed.data,
      ip: request.ip,
    });
    return reply.status(201).send({
      id: result.serverId,
      name: result.name,
      status: result.status,
    });
  });

  // ── GET /api/servers/:id ───────────────────────────────────────────────────
  app.get('/api/servers/:id', { preHandler: [requireAuth] }, async (request, _reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:view', id);
    return getServerDetail(id);
  });

  // ── GET /api/servers/:id/events ────────────────────────────────────────────
  app.get('/api/servers/:id/events', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:view', id);

    const db = getDatabase();
    return db
      .select()
      .from(events)
      .where(eq(events.serverId, id))
      .orderBy(desc(events.ts))
      .limit(100)
      .all();
  });

  // ── GET /api/servers/:id/deploy-stream (SSE) ────────────────────────────────
  app.get('/api/servers/:id/deploy-stream', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:view', id);

    // Hijack the response so Fastify doesn't auto-send a reply
    // (required when writing directly to reply.raw for SSE)
    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering if behind proxy
    });

    // Replay buffered events (steps 1-3 fire synchronously during POST
    // before the SSE client connects, so they'd otherwise be lost)
    const history = getDeployHistory(id);
    for (const evt of history) {
      reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
    }

    const unsubscribe = subscribeDeployProgress(id, (evt) => {
      reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
    });

    request.raw.on('close', () => {
      unsubscribe();
    });

    // Keep connection open until client disconnects
    await new Promise((resolve) => {
      request.raw.on('close', resolve);
    });
  });

  // ── POST /api/servers/:id/start ────────────────────────────────────────────
  app.post('/api/servers/:id/start', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:power', id);
    await startServer(id, user.id, request.ip);
    return { message: 'Server starting.' };
  });

  // ── POST /api/servers/:id/stop ─────────────────────────────────────────────
  app.post('/api/servers/:id/stop', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:power', id);
    await stopServer(id, user.id, request.ip);
    return { message: 'Server stopped.' };
  });

  // ── POST /api/servers/:id/restart ──────────────────────────────────────────
  app.post('/api/servers/:id/restart', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:power', id);
    await restartServer(id, user.id, request.ip);
    return { message: 'Server restarting.' };
  });

  // ── POST /api/servers/:id/kill ─────────────────────────────────────────────
  app.post('/api/servers/:id/kill', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:power', id);
    await killServer(id, user.id, request.ip);
    return { message: 'Server killed.' };
  });

  // ── DELETE /api/servers/:id ────────────────────────────────────────────────
  app.delete('/api/servers/:id', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:delete', id);
    await deleteServer(id, user.id, request.ip);
    return { message: 'Server deleted.' };
  });

  // ── GET /api/servers/:id/stats ─────────────────────────────────────────────
  app.get('/api/servers/:id/stats', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:view', id);

    const detail = await getServerDetail(id);
    const disk = getServerDiskUsage(id, detail.diskLimitMb);

    if (detail.status !== 'running') {
      return {
        cpuPercent: 0,
        memoryUsageMb: 0,
        memoryLimitMb: detail.ramMb,
        memoryPercent: 0,
        networkRxBytes: 0,
        networkTxBytes: 0,
        pids: 0,
        ...disk,
      };
    }

    const db = getDatabase();
    const { servers } = await import('../db/schema.js');
    const server = db.select({ containerId: servers.containerId }).from(servers).where(eq(servers.id, id)).all()[0];

    if (!server?.containerId) {
      return {
        cpuPercent: 0,
        memoryUsageMb: 0,
        memoryLimitMb: detail.ramMb,
        memoryPercent: 0,
        networkRxBytes: 0,
        networkTxBytes: 0,
        pids: 0,
        ...disk,
      };
    }

    try {
      const driver = getDockerDriver();
      const stats = await driver.getContainerStats(server.containerId);
      return {
        ...stats,
        ...disk,
      };
    } catch {
      return {
        cpuPercent: 0,
        memoryUsageMb: 0,
        memoryLimitMb: detail.ramMb,
        memoryPercent: 0,
        networkRxBytes: 0,
        networkTxBytes: 0,
        pids: 0,
        ...disk,
      };
    }
  });

  // ── POST /api/servers/:id/command (Console Execution) ──────────────────────
  app.post('/api/servers/:id/command', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:console', id);

    const parsed = validate(commandSchema, request.body, reply);
    if (!parsed.success) return;

    const result = await executeServerCommand(id, user.id, parsed.data.command, request.ip);
    return reply.status(200).send(result);
  });

  // ── GET /api/servers/:id/diagnose (Diagnosis Engine) ───────────────────────
  app.get('/api/servers/:id/diagnose', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:view', id);

    return diagnoseServer(id);
  });

  // ── POST /api/servers/:id/fixes/apply ──────────────────────────────────────
  app.post('/api/servers/:id/fixes/apply', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:diagnosis', id);

    const parsed = validate(applyFixSchema, request.body, reply);
    if (!parsed.success) return;

    const result = await applyDiagnosisFix(
      id,
      user.id,
      parsed.data.action as FixAction,
      request.ip,
    );
    return reply.status(200).send(result);
  });

  // ── GET /api/servers/:id/debug-bundle (Download Debug ZIP) ──────────────────
  app.get('/api/servers/:id/debug-bundle', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:view', id);

    const zipBuffer = await generateDebugBundle(id);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="vaultrealm-debug-${id}.zip"`)
      .send(zipBuffer);
  });

  // ── GET /api/servers/:id/mods ──────────────────────────────────────────────
  app.get('/api/servers/:id/mods', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:view', id);

    const detail = await getServerDetail(id);
    const folder = getAddonsFolder(detail.templateId);
    const detectedGameVersion = detectServerGameVersion(id, detail.templateId) || detail.version;
    const mods = await listInstalledMods(id, detail.templateId);
    const modpack = getInstalledModpack(id);
    return {
      folder,
      detectedGameVersion,
      serverType: detail.serverType,
      modpack,
      mods,
    };
  });

  // ── POST /api/servers/:id/mods/install ─────────────────────────────────────
  app.post('/api/servers/:id/mods/install', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:files', id);

    const parsed = validate(installModSchema, request.body, reply);
    if (!parsed.success) return;

    const detail = await getServerDetail(id);
    const result = await installModFromUrl(
      id,
      detail.templateId,
      parsed.data.downloadUrl,
      parsed.data.filename,
    );

    writeAudit({
      userId: user.id,
      action: 'server.mod.install',
      target: id,
      ip: request.ip,
      data: { filename: result.filename, projectId: parsed.data.projectId },
    });

    return reply.status(201).send(result);
  });

  // ── POST /api/servers/:id/mods/upload ──────────────────────────────────────
  app.post('/api/servers/:id/mods/upload', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:files', id);

    const parsed = validate(uploadModSchema, request.body, reply);
    if (!parsed.success) return;

    const detail = await getServerDetail(id);
    const result = await saveUploadedMod(
      id,
      detail.templateId,
      parsed.data.filename,
      parsed.data.contentBase64,
    );

    writeAudit({
      userId: user.id,
      action: 'server.mod.upload',
      target: id,
      ip: request.ip,
      data: { filename: result.filename, sizeBytes: result.sizeBytes },
    });

    return reply.status(201).send(result);
  });

  // ── POST /api/servers/:id/mods/toggle ──────────────────────────────────────
  app.post('/api/servers/:id/mods/toggle', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:files', id);

    const parsed = validate(toggleModSchema, request.body, reply);
    if (!parsed.success) return;

    const detail = await getServerDetail(id);
    const result = await toggleMod(id, detail.templateId, parsed.data.filename, parsed.data.enable);

    writeAudit({
      userId: user.id,
      action: 'server.mod.toggle',
      target: id,
      ip: request.ip,
      data: { filename: parsed.data.filename, enable: parsed.data.enable },
    });

    return reply.status(200).send(result);
  });

  // ── DELETE /api/servers/:id/mods/:filename ─────────────────────────────────
  app.delete('/api/servers/:id/mods/:filename', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id, filename } = request.params as { id: string; filename: string };
    await assertCan(user, 'server:files', id);

    const detail = await getServerDetail(id);
    await deleteMod(id, detail.templateId, filename);

    writeAudit({
      userId: user.id,
      action: 'server.mod.delete',
      target: id,
      ip: request.ip,
      data: { filename },
    });

    return reply.status(200).send({ message: 'Mod file deleted.' });
  });

  // ── GET /api/servers/:id/players ───────────────────────────────────────────
  app.get('/api/servers/:id/players', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:view', id);

    return getServerPlayersData(id, user.id);
  });

  // ── POST /api/servers/:id/players/kick ─────────────────────────────────────
  app.post('/api/servers/:id/players/kick', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:console', id);

    const parsed = validate(kickPlayerSchema, request.body, reply);
    if (!parsed.success) return;

    const res = await kickPlayer(id, user.id, parsed.data.player, parsed.data.reason, request.ip);

    writeAudit({
      userId: user.id,
      action: 'server.player.kick',
      target: id,
      ip: request.ip,
      data: { player: parsed.data.player, reason: parsed.data.reason },
    });

    return reply.status(200).send(res);
  });

  // ── POST /api/servers/:id/players/ban ──────────────────────────────────────
  app.post('/api/servers/:id/players/ban', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:console', id);

    const parsed = validate(banPlayerSchema, request.body, reply);
    if (!parsed.success) return;

    const res = await banPlayer(id, user.id, parsed.data.player, parsed.data.reason, request.ip);

    writeAudit({
      userId: user.id,
      action: 'server.player.ban',
      target: id,
      ip: request.ip,
      data: { player: parsed.data.player, reason: parsed.data.reason },
    });

    return reply.status(200).send(res);
  });

  // ── POST /api/servers/:id/players/unban ────────────────────────────────────
  app.post('/api/servers/:id/players/unban', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:console', id);

    const parsed = validate(unbanPlayerSchema, request.body, reply);
    if (!parsed.success) return;

    const res = await unbanPlayer(id, user.id, parsed.data.player, request.ip);

    writeAudit({
      userId: user.id,
      action: 'server.player.unban',
      target: id,
      ip: request.ip,
      data: { player: parsed.data.player },
    });

    return reply.status(200).send(res);
  });

  // ── POST /api/servers/:id/players/ban-ip ───────────────────────────────────
  app.post('/api/servers/:id/players/ban-ip', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:console', id);

    const parsed = validate(banIpSchema, request.body, reply);
    if (!parsed.success) return;

    const res = await banIp(id, user.id, parsed.data.ipOrPlayer, parsed.data.reason, request.ip);

    writeAudit({
      userId: user.id,
      action: 'server.ip.ban',
      target: id,
      ip: request.ip,
      data: { target: parsed.data.ipOrPlayer, reason: parsed.data.reason },
    });

    return reply.status(200).send(res);
  });

  // ── POST /api/servers/:id/players/unban-ip ─────────────────────────────────
  app.post('/api/servers/:id/players/unban-ip', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:console', id);

    const parsed = validate(unbanIpSchema, request.body, reply);
    if (!parsed.success) return;

    const res = await unbanIp(id, user.id, parsed.data.ip, request.ip);

    writeAudit({
      userId: user.id,
      action: 'server.ip.unban',
      target: id,
      ip: request.ip,
      data: { ip: parsed.data.ip },
    });

    return reply.status(200).send(res);
  });

  // ── POST /api/servers/:id/players/op ───────────────────────────────────────
  app.post('/api/servers/:id/players/op', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:console', id);

    const parsed = validate(setOpSchema, request.body, reply);
    if (!parsed.success) return;

    const res = await setPlayerOp(id, user.id, parsed.data.player, parsed.data.op, request.ip);

    writeAudit({
      userId: user.id,
      action: 'server.player.op',
      target: id,
      ip: request.ip,
      data: { player: parsed.data.player, op: parsed.data.op },
    });

    return reply.status(200).send(res);
  });

  // ── GET /api/servers/:id/properties ────────────────────────────────────────
  app.get('/api/servers/:id/properties', { preHandler: [requireAuth] }, async (request) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:settings', id);

    return getServerPropertiesData(id);
  });

  // ── POST /api/servers/:id/properties/property ──────────────────────────────
  app.post('/api/servers/:id/properties/property', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:settings', id);

    const parsed = validate(updatePropertySchema, request.body, reply);
    if (!parsed.success) return;

    const res = await updateServerProperty(id, parsed.data.key, parsed.data.value);

    writeAudit({
      userId: user.id,
      action: 'server.property.update',
      target: id,
      ip: request.ip,
      data: { key: parsed.data.key, value: parsed.data.value },
    });

    return reply.status(200).send(res);
  });

  // ── PUT /api/servers/:id/properties ────────────────────────────────────────
  app.put('/api/servers/:id/properties', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:settings', id);

    const parsed = validate(updatePropertiesBatchSchema, request.body, reply);
    if (!parsed.success) return;

    const res = await updateServerPropertiesBatch(id, parsed.data.properties, parsed.data.rawContent);

    writeAudit({
      userId: user.id,
      action: 'server.properties.update',
      target: id,
      ip: request.ip,
      data: { count: res.count },
    });

    return reply.status(200).send(res);
  });

  // ── POST /api/servers/:id/properties/spawn-point ───────────────────────────
  app.post('/api/servers/:id/properties/spawn-point', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = getRequestUser(request);
    const { id } = request.params as { id: string };
    await assertCan(user, 'server:settings', id);

    const parsed = validate(setSpawnPointSchema, request.body, reply);
    if (!parsed.success) return;

    const res = await setServerWorldSpawn(
      id,
      user.id,
      parsed.data.x,
      parsed.data.y,
      parsed.data.z,
      parsed.data.angle,
      parsed.data.spawnProtection,
    );

    writeAudit({
      userId: user.id,
      action: 'server.spawn_point.set',
      target: id,
      ip: request.ip,
      data: {
        x: parsed.data.x,
        y: parsed.data.y,
        z: parsed.data.z,
        angle: parsed.data.angle,
        spawnProtection: parsed.data.spawnProtection,
      },
    });

    return reply.status(200).send(res);
  });
}
