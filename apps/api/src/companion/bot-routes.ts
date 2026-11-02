/**
 * Bot lifecycle and configuration routes.
 *
 * Provides CRUD for per-server bots, container spawn/despawn via DockerDriver,
 * and quick in-panel companion actions.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import { getDatabase } from '../db/index.js';
import { bots, servers, serverPorts, events, llmEndpoints, users, botUsage, botTraces } from '../db/schema.js';
import { requireAuth, getRequestUser } from '../auth/middleware.js';
import { assertCan } from '../auth/rbac.js';
import { validate } from '../validation.js';
import { writeAudit } from '../audit/log.js';
import { getConfig } from '../config.js';
import { getDockerDriver } from '../servers/service.js';
import { getServerDataDir } from '../servers/volume.js';
import { safepath } from '../safepath.js';
import { createBotToken } from './bot-tokens.js';

// ── Validation Schemas ────────────────────────────────────────────────────────

const updateBotSchema = z.object({
  endpointId: z.string().min(1, 'LLM Endpoint is required'),
  name: z.string().min(1).max(32).default('Buddy'),
  persona: z.string().min(1).max(500).default('helpful friend'),
  model: z.string().max(100).optional().nullable(),
  mode: z.enum(['off', 'manual', 'auto-solo', 'always']).default('manual'),
  authMode: z.enum(['offline', 'microsoft', 'proxy']).default('offline'),
  whoCanCommand: z.enum(['everyone', 'trusted', 'owner_only', 'owner']).default('everyone'),
  ownerPlayerName: z.string().max(32).optional().nullable(),
  trustedPlayers: z.array(z.string().max(32)).optional(),
  dailyTokenBudget: z.number().int().min(1000).max(10_000_000).default(200_000),
  rpmLimit: z.number().int().min(1).max(120).default(10),
  proactive: z.boolean().default(false),
});

const botActionSchema = z.object({
  action: z.enum(['stop', 'follow', 'come', 'status', 'say']),
  message: z.string().max(256).optional(),
});

// ── Routes ────────────────────────────────────────────────────────────────────

export async function botRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireAuth);

  // ── GET /api/servers/:id/companion/bot — get bot config and status ────────
  app.get<{ Params: { id: string } }>('/api/servers/:id/companion/bot', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:view', serverId);

    const db = getDatabase();
    const existing = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];

    if (!existing) {
      return reply.send({ configured: false, bot: null });
    }

    if (existing.containerId && (existing.status === 'joining' || existing.status === 'online')) {
      try {
        const driver = getDockerDriver();
        const inspect = await driver.inspectContainer(existing.containerId);
        if (!inspect.state.running) {
          const newStatus = inspect.state.exitCode !== 0 ? 'error' : 'offline';
          const errMsg =
            inspect.state.error ||
            (inspect.state.exitCode !== 0 ? `Bot container exited with code ${inspect.state.exitCode}` : null);
          db.update(bots)
            .set({ status: newStatus, errorMessage: errMsg })
            .where(eq(bots.id, existing.id))
            .run();
          existing.status = newStatus;
          existing.errorMessage = errMsg;
        }
      } catch {
        db.update(bots)
          .set({ status: 'offline' })
          .where(eq(bots.id, existing.id))
          .run();
        existing.status = 'offline';
      }
    }

    let permissionsConfig: { ownerPlayerName?: string; trustedPlayers?: string[] } = {};
    if (existing.permissionsJson) {
      try {
        permissionsConfig = JSON.parse(existing.permissionsJson);
      } catch {
        // ignore
      }
    }

    return reply.send({
      configured: true,
      bot: {
        id: existing.id,
        serverId: existing.serverId,
        endpointId: existing.endpointId,
        name: existing.name,
        persona: existing.persona,
        model: existing.model,
        mode: existing.mode,
        authMode: existing.authMode,
        whoCanCommand: existing.whoCanCommand,
        ownerPlayerName: permissionsConfig.ownerPlayerName ?? '',
        trustedPlayers: permissionsConfig.trustedPlayers ?? [],
        proactive: existing.proactive,
        dailyTokenBudget: existing.dailyTokenBudget,
        rpmLimit: existing.rpmLimit,
        status: existing.status,
        containerId: existing.containerId,
        lastSpawnedAt: existing.lastSpawnedAt,
        lastDespawnedAt: existing.lastDespawnedAt,
        errorMessage: existing.errorMessage,
        createdAt: existing.createdAt,
      },
    });
  });

  // ── PUT /api/servers/:id/companion/bot — configure or update bot ──────────
  app.put<{ Params: { id: string } }>('/api/servers/:id/companion/bot', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:manage', serverId);

    const parsed = validate(updateBotSchema, request.body, reply);
    if (!parsed.success) return;
    const data = parsed.data;

    const db = getDatabase();

    // Verify server exists
    const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
    if (!server) {
      return reply.status(404).send({ code: 'SERVER_NOT_FOUND', message: 'Server not found.' });
    }

    // Verify endpoint exists
    const endpoint = db.select().from(llmEndpoints).where(eq(llmEndpoints.id, data.endpointId)).all()[0];
    if (!endpoint) {
      return reply.status(404).send({ code: 'ENDPOINT_NOT_FOUND', message: 'Selected LLM Endpoint not found.' });
    }

    const existing = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    let botId: string;

    let permissionsConfig: { ownerPlayerName?: string; trustedPlayers?: string[] } = {};
    if (existing?.permissionsJson) {
      try {
        permissionsConfig = JSON.parse(existing.permissionsJson);
      } catch {
        // ignore
      }
    }
    if (data.ownerPlayerName !== undefined) {
      permissionsConfig.ownerPlayerName = data.ownerPlayerName?.trim() || undefined;
    }
    if (data.trustedPlayers !== undefined) {
      permissionsConfig.trustedPlayers = data.trustedPlayers.map((p) => p.trim()).filter(Boolean);
    }
    const permissionsJson = JSON.stringify(permissionsConfig);
    const normalizedWhoCanCommand =
      data.whoCanCommand === 'owner' || data.whoCanCommand === 'owner_only'
        ? 'owner_only'
        : data.whoCanCommand === 'trusted'
          ? 'trusted'
          : 'everyone';

    if (existing) {
      botId = existing.id;
      db.update(bots)
        .set({
          endpointId: data.endpointId,
          name: data.name,
          persona: data.persona,
          model: data.model ?? null,
          mode: data.mode,
          authMode: data.authMode,
          whoCanCommand: normalizedWhoCanCommand,
          permissionsJson,
          dailyTokenBudget: data.dailyTokenBudget,
          rpmLimit: data.rpmLimit,
          proactive: data.proactive,
        })
        .where(eq(bots.id, botId))
        .run();
    } else {
      botId = nanoid();
      db.insert(bots)
        .values({
          id: botId,
          serverId,
          endpointId: data.endpointId,
          name: data.name,
          persona: data.persona,
          model: data.model ?? null,
          mode: data.mode,
          authMode: data.authMode,
          whoCanCommand: normalizedWhoCanCommand,
          permissionsJson,
          dailyTokenBudget: data.dailyTokenBudget,
          rpmLimit: data.rpmLimit,
          proactive: data.proactive,
          status: 'offline',
        })
        .run();
    }

    writeAudit({
      userId: user.id,
      action: 'bot.configure',
      target: botId,
      ip: request.ip,
      data: { serverId, name: data.name, endpointId: data.endpointId },
    });

    return reply.send({
      id: botId,
      serverId,
      name: data.name,
      status: existing?.status ?? 'offline',
    });
  });

  // ── POST /api/servers/:id/companion/bot/spawn — spawn bot container ──────
  app.post<{ Params: { id: string } }>('/api/servers/:id/companion/bot/spawn', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:spawn', serverId);

    const db = getDatabase();

    const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
    if (!server) {
      return reply.status(404).send({ code: 'SERVER_NOT_FOUND', message: 'Server not found.' });
    }
    if (server.status !== 'running') {
      return reply.status(400).send({
        code: 'SERVER_NOT_RUNNING',
        message: 'Game server must be running before spawning an AI companion.',
      });
    }

    const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    if (!bot) {
      return reply.status(400).send({
        code: 'BOT_NOT_CONFIGURED',
        message: 'AI Companion is not configured for this server. Configure it first.',
      });
    }

    if (bot.status === 'joining' || bot.status === 'online') {
      return reply.status(409).send({
        code: 'BOT_ALREADY_SPAWNED',
        message: `Bot "${bot.name}" is already active (${bot.status}).`,
      });
    }

    // Retrieve server ports to find game port
    const ports = db.select().from(serverPorts).where(eq(serverPorts.serverId, serverId)).all();
    const gamePortEntry = ports.find((p) => p.name === 'game' || p.containerPort === 25565) ?? ports[0];
    const driver = getDockerDriver();
    const config = getConfig();

    let serverHost = 'host.docker.internal';
    let serverPort = gamePortEntry ? gamePortEntry.hostPort : 25565;
    let extraHosts: string[] = ['host.docker.internal:host-gateway'];
    let panelGatewayUrl = config.PANEL_GATEWAY_URL;

    if (driver.isMock) {
      serverHost = server.containerId || 'localhost';
      serverPort = gamePortEntry ? gamePortEntry.containerPort : 25565;
    } else if (server.containerId) {
      try {
        const serverInspect = await driver.inspectContainer(server.containerId);
        const containerIp = serverInspect.networkSettings.ipAddress;
        const gatewayIp = serverInspect.networkSettings.gateway;

        if (containerIp) {
          // Direct bridge container-to-container connection (avoids host DNS and firewall restrictions)
          serverHost = containerIp;
          serverPort = gamePortEntry ? gamePortEntry.containerPort : 25565;
        } else if (gatewayIp) {
          serverHost = gatewayIp;
          serverPort = gamePortEntry ? gamePortEntry.hostPort : 25565;
        }

        if (gatewayIp) {
          extraHosts = [
            `host.docker.internal:${gatewayIp}`,
            'host.docker.internal:host-gateway',
          ];
        }
      } catch (err) {
        console.warn(`[bot] Could not inspect server container ${server.containerId}:`, err);
      }
    }

    if (!driver.isMock) {
      // Containers cannot reach the host panel via "localhost" or "127.0.0.1"
      if (panelGatewayUrl.includes('localhost')) {
        panelGatewayUrl = panelGatewayUrl.replace('localhost', 'host.docker.internal');
      } else if (panelGatewayUrl.includes('127.0.0.1')) {
        panelGatewayUrl = panelGatewayUrl.replace('127.0.0.1', 'host.docker.internal');
      }
    }

    const token = createBotToken(bot.id, 86400); // 24h token

    try {
      // Clean up any stale container if exists
      if (bot.containerId) {
        await driver.stopContainer(bot.containerId, 2).catch(() => {});
        await driver.removeContainer(bot.containerId).catch(() => {});
      }

      // Ensure bot runner image is present locally; pull automatically if missing
      const configuredImage = config.BOT_RUNNER_IMAGE || 'hypertextassassin/vaultrealm-bot-runner:latest';
      const candidateImages = Array.from(
        new Set([
          configuredImage,
          'hypertextassassin/vaultrealm-bot-runner:latest',
          'vaultrealm/bot-runner:latest',
        ]),
      );

      let imageToUse: string | null = null;
      for (const img of candidateImages) {
        if (await driver.hasImage(img)) {
          imageToUse = img;
          break;
        }
      }

      if (!imageToUse) {
        let lastPullErr: Error | null = null;
        for (const img of candidateImages) {
          try {
            console.log(`[bot] Bot runner image "${img}" not found locally. Pulling image...`);
            await driver.pullImage(img);
            imageToUse = img;
            console.log(`[bot] Successfully pulled bot runner image: "${img}".`);
            break;
          } catch (err) {
            console.warn(`[bot] Could not pull image "${img}":`, err);
            lastPullErr = err instanceof Error ? err : new Error(String(err));
          }
        }

        if (!imageToUse) {
          throw new Error(
            `Failed to pull bot runner image (${candidateImages.join(', ')}): ${lastPullErr?.message || 'Image not found'}. Make sure Docker host has internet access or pull '${configuredImage}' manually.`,
          );
        }
      }

      // 1. Read ops.json from server storage if present to auto-detect server operators
      let serverOps: string[] = [];
      try {
        const serverDir = getServerDataDir(serverId);
        const opsPath = safepath.resolve(serverDir, 'ops.json');
        if (fs.existsSync(opsPath)) {
          const raw = fs.readFileSync(opsPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            serverOps = parsed
              .map((p) => (typeof p?.name === 'string' ? p.name.trim() : ''))
              .filter(Boolean);
          }
        }
      } catch {
        // ignore
      }

      // 2. Read stored permissions configuration
      let permissionsConfig: { ownerPlayerName?: string; trustedPlayers?: string[] } = {};
      try {
        permissionsConfig = JSON.parse(bot.permissionsJson || '{}');
      } catch {
        // ignore
      }

      const userRecord = db.select().from(users).where(eq(users.id, user.id)).all()[0];

      // Effective owner: configured in-game owner > first server op > panel username > 'admin'
      const ownerName =
        permissionsConfig.ownerPlayerName?.trim() ||
        serverOps[0] ||
        userRecord?.username ||
        'admin';

      // Effective trusted players: configured trusted + server ops (excluding owner)
      const configuredTrusted = Array.isArray(permissionsConfig.trustedPlayers)
        ? permissionsConfig.trustedPlayers
        : [];
      const combinedTrusted = Array.from(
        new Set([...configuredTrusted, ...serverOps]),
      ).filter((name) => name.toLowerCase() !== ownerName.toLowerCase());

      const whoCanCommand =
        bot.whoCanCommand === 'owner' || bot.whoCanCommand === 'owner_only'
          ? 'owner_only'
          : bot.whoCanCommand === 'trusted'
            ? 'trusted'
            : 'everyone';

      const containerName = `vaultrealm-bot-${bot.id}`;
      const containerId = await driver.createContainer({
        name: containerName,
        image: imageToUse,
        extraHosts,
        labels: {
          'vaultrealm.bot': bot.id,
          'vaultrealm.server': serverId,
        },
        env: {
          BOT_ID: bot.id,
          BOT_NAME: bot.name,
          SERVER_ID: serverId,
          SERVER_HOST: serverHost,
          SERVER_PORT: String(serverPort),
          AUTH_MODE: bot.authMode,
          PERSONA: bot.persona,
          PANEL_GATEWAY_URL: panelGatewayUrl,
          BOT_TOKEN: token,
          OWNER_NAME: ownerName,
          TRUSTED_PLAYERS: combinedTrusted.join(','),
          WHO_CAN_COMMAND: whoCanCommand,
          PROTECTED_ZONES_JSON: bot.protectedZonesJson || '[]',
          MINECRAFT_VERSION: (() => {
            try {
              const envMap = JSON.parse(server.envJson || '{}');
              return envMap.VERSION && envMap.VERSION !== 'LATEST' ? envMap.VERSION : '';
            } catch {
              return '';
            }
          })(),
        },
        ports: [],
        volumes: [],
        memoryMb: 256,
        cpuLimit: 0.5,
        restartPolicy: 'on-failure',
      });

      await driver.startContainer(containerId);

      const now = new Date().toISOString();
      db.update(bots)
        .set({
          status: 'joining',
          containerId,
          lastSpawnedAt: now,
          errorMessage: null,
        })
        .where(eq(bots.id, bot.id))
        .run();

      db.insert(events)
        .values({
          id: nanoid(),
          serverId,
          kind: 'bot.spawn',
          message: `Companion bot "${bot.name}" spawned into server.`,
          dataJson: JSON.stringify({ botId: bot.id, containerId }),
        })
        .run();

      writeAudit({
        userId: user.id,
        action: 'bot.spawn',
        target: bot.id,
        ip: request.ip,
        data: { serverId, containerId },
      });

      return reply.send({ success: true, status: 'joining', containerId });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      db.update(bots)
        .set({
          status: 'error',
          errorMessage: errMsg,
        })
        .where(eq(bots.id, bot.id))
        .run();

      db.insert(events)
        .values({
          id: nanoid(),
          serverId,
          kind: 'bot.error',
          message: `Failed to spawn bot: ${errMsg}`,
        })
        .run();

      return reply.status(500).send({
        code: 'SPAWN_FAILED',
        message: `Failed to start companion bot container: ${errMsg}`,
      });
    }
  });

  // ── POST /api/servers/:id/companion/bot/despawn — stop/remove bot container
  app.post<{ Params: { id: string } }>('/api/servers/:id/companion/bot/despawn', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:spawn', serverId);

    const db = getDatabase();
    const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    if (!bot) {
      return reply.status(404).send({ code: 'BOT_NOT_FOUND', message: 'No companion bot configured.' });
    }

    const driver = getDockerDriver();

    if (bot.containerId) {
      try {
        await driver.stopContainer(bot.containerId, 5).catch(() => {});
        await driver.removeContainer(bot.containerId).catch(() => {});
      } catch {
        // Container may have already exited
      }
    }

    const now = new Date().toISOString();
    db.update(bots)
      .set({
        status: 'offline',
        containerId: null,
        lastDespawnedAt: now,
      })
      .where(eq(bots.id, bot.id))
      .run();

    db.insert(events)
      .values({
        id: nanoid(),
        serverId,
        kind: 'bot.despawn',
        message: `Companion bot "${bot.name}" despawned.`,
      })
      .run();

    writeAudit({
      userId: user.id,
      action: 'bot.despawn',
      target: bot.id,
      ip: request.ip,
      data: { serverId },
    });

    return reply.send({ success: true, status: 'offline' });
  });

  // ── POST /api/servers/:id/companion/bot/action — quick companion action ──
  app.post<{ Params: { id: string } }>('/api/servers/:id/companion/bot/action', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:manage', serverId);

    const parsed = validate(botActionSchema, request.body, reply);
    if (!parsed.success) return;
    const { action, message } = parsed.data;

    const db = getDatabase();
    const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    if (!bot) {
      return reply.status(404).send({ code: 'BOT_NOT_FOUND', message: 'No companion bot configured.' });
    }

    writeAudit({
      userId: user.id,
      action: 'bot.action',
      target: bot.id,
      ip: request.ip,
      data: { serverId, action, message },
    });

    return reply.send({
      success: true,
      action,
      executedAt: new Date().toISOString(),
    });
  });

  // ── GET /api/servers/:id/companion/bot/logs — container logs ─────────────
  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    '/api/servers/:id/companion/bot/logs',
    async (request, reply) => {
      const user = getRequestUser(request);
      const { id: serverId } = request.params;
      await assertCan(user, 'companion:view', serverId);

      const db = getDatabase();
      const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
      if (!bot) {
        return reply.status(404).send({ code: 'BOT_NOT_FOUND', message: 'No companion bot configured.' });
      }

      if (!bot.containerId) {
        return reply.send({ logs: [], containerRunning: false });
      }

      const driver = getDockerDriver();
      const tail = request.query.tail ? parseInt(request.query.tail, 10) : 200;

      try {
        const logs = await driver.getContainerLogs(bot.containerId, tail);
        return reply.send({ logs, containerRunning: bot.status === 'online' || bot.status === 'joining' });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return reply.send({
          logs: [`[VaultRealm] Unable to read container logs: ${errMsg}`],
          containerRunning: false,
        });
      }
    },
  );

  // ── GET /api/servers/:id/companion/bot/usage — daily tokens & budget ──────
  app.get<{ Params: { id: string } }>('/api/servers/:id/companion/bot/usage', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:view', serverId);

    const db = getDatabase();
    const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    if (!bot) {
      return reply.status(404).send({ code: 'BOT_NOT_FOUND', message: 'No companion bot configured.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const usageRow = db
      .select()
      .from(botUsage)
      .where(and(eq(botUsage.botId, bot.id), eq(botUsage.day, today)))
      .all()[0];

    const promptTokens = usageRow?.promptTokens ?? 0;
    const completionTokens = usageRow?.completionTokens ?? 0;
    const totalTokens = promptTokens + completionTokens;
    const requests = usageRow?.requests ?? 0;
    const dailyBudget = bot.dailyTokenBudget ?? 200_000;
    const percentUsed = Math.min(100, Math.round((totalTokens / dailyBudget) * 100));

    // Estimated cost ($0.002 per 1k tokens standard estimate)
    const estimatedCostUsd = Number(((totalTokens / 1000) * 0.002).toFixed(4));

    return reply.send({
      day: today,
      botId: bot.id,
      promptTokens,
      completionTokens,
      totalTokens,
      requests,
      dailyBudget,
      remainingTokens: Math.max(0, dailyBudget - totalTokens),
      percentUsed,
      estimatedCostUsd,
      rpmLimit: bot.rpmLimit ?? 10,
    });
  });

  // ── GET /api/servers/:id/companion/bot/traces — recent activity & traces ──
  app.get<{ Params: { id: string } }>('/api/servers/:id/companion/bot/traces', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:view', serverId);

    const db = getDatabase();
    const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    if (!bot) {
      return reply.status(404).send({ code: 'BOT_NOT_FOUND', message: 'No companion bot configured.' });
    }

    const rows = db
      .select()
      .from(botTraces)
      .where(eq(botTraces.botId, bot.id))
      .orderBy(desc(botTraces.ts))
      .limit(50)
      .all();

    const traces = rows.map((row) => {
      let requestObj: unknown = null;
      let responseObj: unknown = null;
      try {
        if (row.requestJson) requestObj = JSON.parse(row.requestJson);
      } catch {
        // ignore
      }
      try {
        if (row.responseJson) responseObj = JSON.parse(row.responseJson);
      } catch {
        // ignore
      }

      return {
        id: row.id,
        timestamp: row.ts,
        latencyMs: row.latencyMs,
        status: row.status,
        request: requestObj,
        response: responseObj,
      };
    });

    return reply.send({ traces });
  });

  // ── POST /api/servers/:id/companion/bot/device-code — Microsoft auth ─────
  app.post<{ Params: { id: string } }>('/api/servers/:id/companion/bot/device-code', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:manage', serverId);

    const db = getDatabase();
    const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    if (!bot) {
      return reply.status(404).send({ code: 'BOT_NOT_FOUND', message: 'No companion bot configured.' });
    }

    // Generate simulated/real Microsoft device-code payload
    const userCode = `VRMC-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const verificationUri = 'https://microsoft.com/link';
    const expiresIn = 900; // 15 mins

    writeAudit({
      userId: user.id,
      action: 'bot.microsoft_device_code',
      target: bot.id,
      ip: request.ip,
      data: { serverId },
    });

    return reply.send({
      userCode,
      verificationUri,
      expiresIn,
      message: `Go to ${verificationUri} and enter code ${userCode} to authenticate this bot with Microsoft.`,
    });
  });
}
