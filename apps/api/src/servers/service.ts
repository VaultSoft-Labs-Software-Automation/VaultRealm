/**
 * Server service — business logic for game server lifecycle.
 *
 * Orchestrates between the database, Docker driver, templates, and port allocator.
 * All Docker access goes through the DockerDriver interface (AGENTS.md rule).
 */

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase } from '../db/index.js';
import fs from 'node:fs';
import {
  servers,
  serverPorts,
  events,
  serverMembers,
  diagnoses,
  backups,
  bots,
  botUsage,
  botMemory,
  botTraces,
  botPlayers,
} from '../db/schema.js';
import { getServerDataDir } from './volume.js';
import { getConfig } from '../config.js';
import type { DockerDriver } from '../docker/driver.js';
import { getTemplate, calculateMinecraftHeapMb } from './templates.js';
import { allocatePorts } from './ports.js';
import { writeAudit } from '../audit/log.js';
import type { AuthUser } from '../auth/rbac.js';

// ── Driver instance (set at startup) ─────────────────────────────────────────
let _driver: DockerDriver | null = null;

export function setDockerDriver(driver: DockerDriver): void {
  _driver = driver;
}

export function getDockerDriver(): DockerDriver {
  if (!_driver) throw new Error('Docker driver not initialized');
  return _driver;
}

// ── Create server ────────────────────────────────────────────────────────────

export interface CreateServerInput {
  name: string;
  templateId: string;
  ramMb?: number;
  cpuLimit?: number;
  diskLimitMb?: number;
  env?: Record<string, string>;
}

export async function createServer(
  user: AuthUser,
  input: CreateServerInput,
  ip?: string,
): Promise<{ id: string; name: string; status: string }> {
  const template = getTemplate(input.templateId);
  if (!template) {
    const error = new Error(`Unknown template: ${input.templateId}`) as Error & {
      statusCode: number;
      code: string;
    };
    error.statusCode = 400;
    error.code = 'INVALID_TEMPLATE';
    throw error;
  }

  const db = getDatabase();

  // ── Quota check ──────────────────────────────────────────────────────────
  const userServers = db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.ownerId, user.id))
    .all();

  // Get user quota (from user record)
  const { users } = await import('../db/schema.js');
  const userRecord = db
    .select({ quotaServers: users.quotaServers, quotaRamMb: users.quotaRamMb })
    .from(users)
    .where(eq(users.id, user.id))
    .all()[0];

  if (userRecord && userServers.length >= userRecord.quotaServers) {
    const error = new Error(
      `Server quota exceeded. You have ${userServers.length}/${userRecord.quotaServers} servers.`,
    ) as Error & { statusCode: number; code: string };
    error.statusCode = 403;
    error.code = 'QUOTA_EXCEEDED';
    throw error;
  }

  const ramMb = input.ramMb ?? template.defaultRamMb;
  if (ramMb < template.minRamMb) {
    const error = new Error(
      `Minimum RAM for ${template.name} is ${template.minRamMb} MB.`,
    ) as Error & { statusCode: number; code: string };
    error.statusCode = 400;
    error.code = 'INVALID_RESOURCES';
    throw error;
  }

  // ── Allocate ports ───────────────────────────────────────────────────────
  const hostPorts = allocatePorts(template.ports.length);

  // ── Create DB record ─────────────────────────────────────────────────────
  const serverId = nanoid();
  const envJson = JSON.stringify({
    ...Object.fromEntries(
      template.env
        .filter((e) => e.default !== undefined)
        .map((e) => [e.key, e.default]),
    ),
    ...(input.env ?? {}),
    // Auto-set memory for Minecraft with safe JVM off-heap headroom
    ...(template.id.startsWith('minecraft') && !input.env?.MEMORY
      ? { MEMORY: `${calculateMinecraftHeapMb(ramMb)}M` }
      : {}),
  });

  db.insert(servers)
    .values({
      id: serverId,
      ownerId: user.id,
      name: input.name,
      templateId: input.templateId,
      ramMb,
      cpuLimit: input.cpuLimit ?? template.defaultCpu,
      diskLimitMb: input.diskLimitMb ?? template.defaultDiskMb,
      envJson,
      status: 'creating',
    })
    .run();

  // Insert port mappings
  for (let i = 0; i < template.ports.length; i++) {
    const tp = template.ports[i]!;
    db.insert(serverPorts)
      .values({
        id: nanoid(),
        serverId,
        name: tp.name,
        hostPort: hostPorts[i]!,
        containerPort: tp.containerPort,
        protocol: tp.protocol,
      })
      .run();
  }

  writeAudit({
    userId: user.id,
    action: 'server.create',
    target: serverId,
    ip,
    data: { name: input.name, templateId: input.templateId, ramMb },
  });

  return { id: serverId, name: input.name, status: 'creating' };
}

// ── Start server ─────────────────────────────────────────────────────────────

export async function startServer(serverId: string, userId: string, ip?: string): Promise<void> {
  const db = getDatabase();
  const driver = getDockerDriver();

  const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
  if (!server) throw makeError(404, 'NOT_FOUND', 'Server not found.');

  if (server.status === 'creating' || server.status === 'pulling' || server.status === 'starting') {
    throw makeError(409, 'CONFLICT', `Server is already ${server.status}. Please wait for it to finish.`);
  }
  if (server.status === 'stopping') {
    throw makeError(409, 'CONFLICT', 'Server is currently stopping. Please wait.');
  }

  const template = getTemplate(server.templateId);
  if (!template) throw makeError(500, 'INTERNAL_ERROR', 'Server template not found.');

  const ports = db
    .select()
    .from(serverPorts)
    .where(eq(serverPorts.serverId, serverId))
    .all();

  const config = getConfig();

  // ── If container exists, check if it's still valid or start it ────────
  if (server.containerId) {
    try {
      const inspect = await driver.inspectContainer(server.containerId);
      const containerRamMb = Math.round(inspect.hostConfig.memory / (1024 * 1024));
      const hasStaleMemory = containerRamMb > 0 && containerRamMb !== server.ramMb;
      const isMinecraft = template.id.startsWith('minecraft');
      const hasUnsafeHeap =
        isMinecraft &&
        inspect.config.env?.some((e) => {
          if (!e.startsWith('MEMORY=')) return false;
          const val = parseInt(e.substring(7), 10);
          return !isNaN(val) && val >= server.ramMb;
        });

      if (hasStaleMemory || hasUnsafeHeap) {
        // Container has stale memory limits or unsafe Java heap; recreate cleanly
        try {
          await driver.stopContainer(server.containerId, 5);
        } catch {
          // Container may already be stopped
        }
        try {
          await driver.removeContainer(server.containerId, false);
        } catch {
          // Container may already be removed
        }
        server.containerId = null;
        db.update(servers).set({ containerId: null }).where(eq(servers.id, serverId)).run();
      } else if (!inspect.state.running) {
        db.update(servers).set({ status: 'starting' }).where(eq(servers.id, serverId)).run();
        await driver.startContainer(server.containerId);
        db.update(servers)
          .set({ status: 'running', lastStartedAt: new Date().toISOString() })
          .where(eq(servers.id, serverId))
          .run();
        return;
      } else {
        return;
      }
    } catch {
      // Container might have been removed externally — recreate below
      server.containerId = null;
      db.update(servers).set({ containerId: null }).where(eq(servers.id, serverId)).run();
    }
  }

  // ── Pull image if needed ───────────────────────────────────────────────
  db.update(servers).set({ status: 'pulling' }).where(eq(servers.id, serverId)).run();

  const hasImage = await driver.hasImage(template.image);
  if (!hasImage) {
    await driver.pullImage(template.image);
  }

  // ── Create container ───────────────────────────────────────────────────
  db.update(servers).set({ status: 'starting' }).where(eq(servers.id, serverId)).run();

  const env = JSON.parse(server.envJson) as Record<string, string>;

  // Auto-set or fix safe memory headroom for Minecraft
  if (template.id.startsWith('minecraft')) {
    const safeHeap = calculateMinecraftHeapMb(server.ramMb);
    const configuredHeap = env.MEMORY ? parseInt(env.MEMORY, 10) : 0;
    if (!env.MEMORY || (!isNaN(configuredHeap) && configuredHeap >= server.ramMb)) {
      env.MEMORY = `${safeHeap}M`;
      db.update(servers)
        .set({ envJson: JSON.stringify(env) })
        .where(eq(servers.id, serverId))
        .run();
    }
  }

  // Generate RCON password if not set
  if (template.rcon && !env[template.rcon.passwordEnv]) {
    env[template.rcon.passwordEnv] = nanoid(16);
    db.update(servers)
      .set({ envJson: JSON.stringify(env) })
      .where(eq(servers.id, serverId))
      .run();
  }

  const dataDir = config.DATA_DIR.replace(/\\/g, '/');

  const containerId = await driver.createContainer({
    name: `vr-${serverId}`,
    image: template.image,
    env,
    labels: {
      'vaultrealm.server': serverId,
      'vaultrealm.template': server.templateId,
      'vaultrealm.owner': server.ownerId,
    },
    ports: ports.map((p) => ({
      hostPort: p.hostPort,
      containerPort: p.containerPort,
      protocol: p.protocol as 'tcp' | 'udp',
    })),
    volumes: [
      {
        hostPath: `${dataDir}/servers/${serverId}`,
        containerPath: template.dataDir,
        readOnly: false,
      },
    ],
    memoryMb: server.ramMb,
    cpuLimit: server.cpuLimit,
    restartPolicy: 'unless-stopped',
  });

  await driver.startContainer(containerId);

  db.update(servers)
    .set({
      containerId,
      status: 'running',
      lastStartedAt: new Date().toISOString(),
    })
    .where(eq(servers.id, serverId))
    .run();

  writeAudit({
    userId,
    action: 'server.start',
    target: serverId,
    ip,
  });
}

// ── Stop server ──────────────────────────────────────────────────────────────

export async function stopServer(serverId: string, userId: string, ip?: string): Promise<void> {
  const db = getDatabase();
  const driver = getDockerDriver();

  const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
  if (!server) throw makeError(404, 'NOT_FOUND', 'Server not found.');
  if (!server.containerId) throw makeError(400, 'NOT_RUNNING', 'Server has no container.');

  const template = getTemplate(server.templateId);
  const timeout = template?.stopTimeout ?? 15;

  db.update(servers).set({ status: 'stopping' }).where(eq(servers.id, serverId)).run();

  try {
    await driver.stopContainer(server.containerId, timeout);
  } catch {
    // Container may already be stopped
  }

  db.update(servers).set({ status: 'stopped' }).where(eq(servers.id, serverId)).run();

  writeAudit({ userId, action: 'server.stop', target: serverId, ip });
}

// ── Restart server ───────────────────────────────────────────────────────────

export async function restartServer(serverId: string, userId: string, ip?: string): Promise<void> {
  const db = getDatabase();
  const driver = getDockerDriver();

  const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
  if (!server) throw makeError(404, 'NOT_FOUND', 'Server not found.');
  if (!server.containerId) {
    // No container — do a fresh start
    await startServer(serverId, userId, ip);
    return;
  }

  const template = getTemplate(server.templateId);
  const timeout = template?.stopTimeout ?? 15;

  db.update(servers).set({ status: 'starting' }).where(eq(servers.id, serverId)).run();

  try {
    const inspect = await driver.inspectContainer(server.containerId);
    const containerRamMb = Math.round(inspect.hostConfig.memory / (1024 * 1024));
    const isMinecraft = template?.id.startsWith('minecraft');
    const hasUnsafeHeap =
      isMinecraft &&
      inspect.config.env?.some((e) => {
        if (!e.startsWith('MEMORY=')) return false;
        const val = parseInt(e.substring(7), 10);
        return !isNaN(val) && val >= server.ramMb;
      });

    if ((containerRamMb > 0 && containerRamMb !== server.ramMb) || hasUnsafeHeap) {
      // Container has stale memory limits or unsafe Java heap; recreate cleanly
      try {
        await driver.stopContainer(server.containerId, timeout);
      } catch {
        // ignore
      }
      try {
        await driver.removeContainer(server.containerId, false);
      } catch {
        // ignore
      }
      db.update(servers).set({ containerId: null }).where(eq(servers.id, serverId)).run();
      await startServer(serverId, userId, ip);
      return;
    }

    await driver.restartContainer(server.containerId, timeout);
  } catch {
    // If restart fails, try start
    await driver.startContainer(server.containerId);
  }

  db.update(servers)
    .set({ status: 'running', lastStartedAt: new Date().toISOString() })
    .where(eq(servers.id, serverId))
    .run();

  writeAudit({ userId, action: 'server.restart', target: serverId, ip });
}

// ── Kill server ──────────────────────────────────────────────────────────────

export async function killServer(serverId: string, userId: string, ip?: string): Promise<void> {
  const db = getDatabase();
  const driver = getDockerDriver();

  const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
  if (!server) throw makeError(404, 'NOT_FOUND', 'Server not found.');
  if (!server.containerId) throw makeError(400, 'NOT_RUNNING', 'Server has no container.');

  await driver.killContainer(server.containerId);
  db.update(servers).set({ status: 'stopped' }).where(eq(servers.id, serverId)).run();

  writeAudit({ userId, action: 'server.kill', target: serverId, ip });
}

// ── Delete server ────────────────────────────────────────────────────────────

export async function deleteServer(serverId: string, userId: string, ip?: string): Promise<void> {
  const db = getDatabase();
  const driver = getDockerDriver();

  const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
  if (!server) throw makeError(404, 'NOT_FOUND', 'Server not found.');

  // 1. Clean up companion bot container if it exists
  const companionBots = db.select().from(bots).where(eq(bots.serverId, serverId)).all();
  for (const companionBot of companionBots) {
    if (companionBot.containerId) {
      try {
        await driver.stopContainer(companionBot.containerId, 5);
      } catch {
        // may already be stopped
      }
      try {
        await driver.removeContainer(companionBot.containerId, false);
      } catch {
        // may already be removed
      }
    }
  }

  // 2. Stop and remove container if it exists
  if (server.containerId) {
    try {
      await driver.stopContainer(server.containerId, 10);
    } catch {
      // may already be stopped
    }
    try {
      await driver.removeContainer(server.containerId, false);
    } catch {
      // may already be removed
    }
  }

  // 3. Delete child records first in a transaction to respect FK constraints
  db.transaction((tx) => {
    for (const companionBot of companionBots) {
      tx.delete(botUsage).where(eq(botUsage.botId, companionBot.id)).run();
      tx.delete(botMemory).where(eq(botMemory.botId, companionBot.id)).run();
      tx.delete(botTraces).where(eq(botTraces.botId, companionBot.id)).run();
      tx.delete(botPlayers).where(eq(botPlayers.botId, companionBot.id)).run();
      tx.delete(bots).where(eq(bots.id, companionBot.id)).run();
    }
    tx.delete(diagnoses).where(eq(diagnoses.serverId, serverId)).run();
    tx.delete(events).where(eq(events.serverId, serverId)).run();
    tx.delete(backups).where(eq(backups.serverId, serverId)).run();
    tx.delete(serverMembers).where(eq(serverMembers.serverId, serverId)).run();
    tx.delete(serverPorts).where(eq(serverPorts.serverId, serverId)).run();
    tx.delete(servers).where(eq(servers.id, serverId)).run();
  });

  // 4. Purge persistent storage volume directory
  try {
    const serverDir = getServerDataDir(serverId);
    if (fs.existsSync(serverDir)) {
      fs.rmSync(serverDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[volume] Failed to purge server volume for ${serverId}:`, err);
  }

  writeAudit({ userId, action: 'server.delete', target: serverId, ip });
}

// ── Get server status ────────────────────────────────────────────────────────

export interface ServerDetail {
  id: string;
  name: string;
  templateId: string;
  templateName: string;
  status: string;
  ramMb: number;
  cpuLimit: number;
  diskLimitMb: number;
  ports: Array<{ name: string; hostPort: number; containerPort: number; protocol: string }>;
  createdAt: string;
  lastStartedAt: string | null;
  serverType?: string;
  version?: string;
}

function parseServerMeta(envJson: string, templateId: string): { serverType?: string; version?: string } {
  try {
    const env = JSON.parse(envJson || '{}') as Record<string, string>;
    const serverType = env.TYPE || (templateId === 'minecraft-bedrock' ? 'BEDROCK' : undefined);
    const version = env.VERSION || undefined;
    return { serverType, version };
  } catch {
    return {};
  }
}

export async function getServerDetail(serverId: string): Promise<ServerDetail> {
  const db = getDatabase();

  const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
  if (!server) throw makeError(404, 'NOT_FOUND', 'Server not found.');

  const template = getTemplate(server.templateId);
  const ports = db.select().from(serverPorts).where(eq(serverPorts.serverId, serverId)).all();
  const { serverType, version } = parseServerMeta(server.envJson, server.templateId);

  // Try to sync status from Docker if container exists
  if (server.containerId) {
    try {
      const driver = getDockerDriver();
      const inspect = await driver.inspectContainer(server.containerId);
      const dockerStatus = inspect.state.running
        ? 'running'
        : inspect.state.oomKilled
          ? 'crashed'
          : 'stopped';

      if (dockerStatus !== server.status) {
        db.update(servers)
          .set({ status: dockerStatus })
          .where(eq(servers.id, serverId))
          .run();
        server.status = dockerStatus;
      }
    } catch {
      // Container may have been removed externally
      if (server.status === 'running') {
        db.update(servers).set({ status: 'stopped' }).where(eq(servers.id, serverId)).run();
        server.status = 'stopped';
      }
    }
  }

  return {
    id: server.id,
    name: server.name,
    templateId: server.templateId,
    templateName: template?.name ?? server.templateId,
    status: server.status,
    ramMb: server.ramMb,
    cpuLimit: server.cpuLimit,
    diskLimitMb: server.diskLimitMb,
    ports: ports.map((p) => ({
      name: p.name,
      hostPort: p.hostPort,
      containerPort: p.containerPort,
      protocol: p.protocol,
    })),
    createdAt: server.createdAt,
    lastStartedAt: server.lastStartedAt,
    serverType,
    version,
  };
}

// ── List user's servers ──────────────────────────────────────────────────────

export async function listUserServers(userId: string): Promise<ServerDetail[]> {
  const db = getDatabase();

  const userServers = db.select().from(servers).where(eq(servers.ownerId, userId)).all();
  const results: ServerDetail[] = [];

  for (const server of userServers) {
    const template = getTemplate(server.templateId);
    const ports = db.select().from(serverPorts).where(eq(serverPorts.serverId, server.id)).all();
    const { serverType, version } = parseServerMeta(server.envJson, server.templateId);

    results.push({
      id: server.id,
      name: server.name,
      templateId: server.templateId,
      templateName: template?.name ?? server.templateId,
      status: server.status,
      ramMb: server.ramMb,
      cpuLimit: server.cpuLimit,
      diskLimitMb: server.diskLimitMb,
      ports: ports.map((p) => ({
        name: p.name,
        hostPort: p.hostPort,
        containerPort: p.containerPort,
        protocol: p.protocol,
      })),
      createdAt: server.createdAt,
      lastStartedAt: server.lastStartedAt,
      serverType,
      version,
    });
  }

  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
