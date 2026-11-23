/**
 * Companion routes — LLM endpoint management and companion config.
 *
 * CRUD for LLM endpoints with encrypted API keys, SSRF validation,
 * test-connection, and companion configuration per server.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDatabase } from '../db/index.js';
import { llmEndpoints, bots, botUsage, botTraces } from '../db/schema.js';
import { requireAuth, getRequestUser } from '../auth/middleware.js';
import { assertCan } from '../auth/rbac.js';
import { validate } from '../validation.js';
import { writeAudit } from '../audit/log.js';
import { encryptApiKey, decryptApiKey, maskApiKey } from './crypto.js';
import { validateEndpointUrl } from './ssrf.js';
import { testConnection } from './test-connection.js';
import { createBotToken } from './bot-tokens.js';

// ── Validation Schemas ────────────────────────────────────────────────────────

const createEndpointSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  baseUrl: z.string().url('Invalid URL'),
  apiKey: z.string().optional(),
  defaultModel: z.string().max(100).optional(),
  extraHeaders: z.record(z.string()).optional(),
  timeoutS: z.number().int().min(5).max(120).optional(),
});

const updateEndpointSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  baseUrl: z.string().url('Invalid URL').optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().max(100).optional().nullable(),
  extraHeaders: z.record(z.string()).optional().nullable(),
  timeoutS: z.number().int().min(5).max(120).optional(),
});

const testEndpointSchema = z.object({
  model: z.string().max(100).optional().nullable(),
});

// ── Presets ────────────────────────────────────────────────────────────────────

const ENDPOINT_PRESETS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
  { id: 'vercel', name: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1', defaultModel: 'openai/gpt-4o-mini' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-8b-instant' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo' },
  { id: 'ollama', name: 'Ollama (Local)', baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.1' },
  { id: 'lmstudio', name: 'LM Studio (Local)', baseUrl: 'http://localhost:1234/v1', defaultModel: 'loaded-model' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1', defaultModel: 'default' },
  { id: 'custom', name: 'Custom', baseUrl: '', defaultModel: '' },
];

// ── Routes ────────────────────────────────────────────────────────────────────

export async function companionRoutes(app: FastifyInstance): Promise<void> {
  // All companion routes require authentication
  app.addHook('onRequest', requireAuth);

  // ── GET /api/llm-endpoints/presets — available presets ───────────────────
  app.get('/api/llm-endpoints/presets', async () => {
    return { presets: ENDPOINT_PRESETS };
  });

  // ── POST /api/llm-endpoints — create an endpoint ───────────────────────
  app.post('/api/llm-endpoints', async (request, reply) => {
    const user = getRequestUser(request);
    await assertCan(user, 'companion:manage');

    const parsed = validate(createEndpointSchema, request.body, reply);
    if (!parsed.success) return;
    const { name, baseUrl, apiKey, defaultModel, extraHeaders, timeoutS } = parsed.data;

    // SSRF check
    const ssrfResult = await validateEndpointUrl(baseUrl, user.role === 'admin');
    if (!ssrfResult.safe) {
      return reply.status(400).send({
        code: 'SSRF_BLOCKED',
        message: ssrfResult.reason ?? 'URL is blocked for security reasons.',
      });
    }

    const db = getDatabase();
    const id = nanoid();

    db.insert(llmEndpoints)
      .values({
        id,
        ownerId: user.id,
        scope: 'user',
        name,
        baseUrl,
        apiKeyEnc: apiKey ? encryptApiKey(apiKey) : null,
        defaultModel: defaultModel ?? null,
        headersJson: extraHeaders ? JSON.stringify(extraHeaders) : null,
        timeoutS: timeoutS ?? 30,
      })
      .run();

    writeAudit({
      userId: user.id,
      action: 'llm-endpoint.create',
      target: id,
      ip: request.ip,
      data: { name, baseUrl },
    });

    return reply.status(201).send({
      id,
      name,
      baseUrl,
      defaultModel: defaultModel ?? null,
      lastFour: maskApiKey(apiKey ?? null),
      timeoutS: timeoutS ?? 30,
    });
  });

  // ── GET /api/llm-endpoints — list user's endpoints ──────────────────────
  app.get('/api/llm-endpoints', async (request) => {
    const user = getRequestUser(request);
    // Admins see all; users see their own
    const db = getDatabase();

    const rows = user.role === 'admin'
      ? db.select().from(llmEndpoints).all()
      : db.select().from(llmEndpoints).where(eq(llmEndpoints.ownerId, user.id)).all();

    return {
      endpoints: rows.map((r) => {
        let lastFour: string | null = null;
        let keyDecryptionFailed = false;
        if (r.apiKeyEnc) {
          try {
            lastFour = maskApiKey(decryptApiKey(r.apiKeyEnc));
          } catch {
            lastFour = '****';
            keyDecryptionFailed = true;
          }
        }
        return {
          id: r.id,
          ownerId: r.ownerId,
          scope: r.scope,
          name: r.name,
          baseUrl: r.baseUrl,
          defaultModel: r.defaultModel,
          lastFour,
          hasKey: !!r.apiKeyEnc,
          keyDecryptionFailed,
          supportsTools: r.supportsTools,
          timeoutS: r.timeoutS,
          createdAt: r.createdAt,
        };
      }),
    };
  });

  // ── PUT /api/llm-endpoints/:id — update an endpoint ─────────────────────
  app.put<{ Params: { id: string } }>('/api/llm-endpoints/:id', async (request, reply) => {
    const user = getRequestUser(request);
    await assertCan(user, 'companion:manage');

    const { id } = request.params;
    const db = getDatabase();

    // Verify ownership
    const existing = db.select().from(llmEndpoints).where(eq(llmEndpoints.id, id)).all()[0];
    if (!existing) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'Endpoint not found.' });
    }
    if (existing.ownerId !== user.id && user.role !== 'admin') {
      return reply.status(403).send({ code: 'FORBIDDEN', message: 'Not your endpoint.' });
    }

    const parsed = validate(updateEndpointSchema, request.body, reply);
    if (!parsed.success) return;
    const updates = parsed.data;

    // SSRF check on new URL
    if (updates.baseUrl) {
      const ssrfResult = await validateEndpointUrl(updates.baseUrl, user.role === 'admin');
      if (!ssrfResult.safe) {
        return reply.status(400).send({
          code: 'SSRF_BLOCKED',
          message: ssrfResult.reason ?? 'URL is blocked for security reasons.',
        });
      }
    }

    // Build update set
    const updateSet: Record<string, unknown> = {};
    if (updates.name !== undefined) updateSet.name = updates.name;
    if (updates.baseUrl !== undefined) updateSet.baseUrl = updates.baseUrl;
    if (updates.apiKey !== undefined) {
      updateSet.apiKeyEnc = updates.apiKey ? encryptApiKey(updates.apiKey) : null;
    }
    if (updates.defaultModel !== undefined) updateSet.defaultModel = updates.defaultModel;
    if (updates.extraHeaders !== undefined) {
      updateSet.headersJson = updates.extraHeaders ? JSON.stringify(updates.extraHeaders) : null;
    }
    if (updates.timeoutS !== undefined) updateSet.timeoutS = updates.timeoutS;

    if (Object.keys(updateSet).length > 0) {
      db.update(llmEndpoints)
        .set(updateSet)
        .where(eq(llmEndpoints.id, id))
        .run();
    }

    writeAudit({
      userId: user.id,
      action: 'llm-endpoint.update',
      target: id,
      ip: request.ip,
      data: { fields: Object.keys(updateSet) },
    });

    return reply.send({ id, updated: Object.keys(updateSet) });
  });

  // ── DELETE /api/llm-endpoints/:id — delete an endpoint ──────────────────
  app.delete<{ Params: { id: string } }>('/api/llm-endpoints/:id', async (request, reply) => {
    const user = getRequestUser(request);
    await assertCan(user, 'companion:manage');

    const { id } = request.params;
    const db = getDatabase();

    const existing = db.select().from(llmEndpoints).where(eq(llmEndpoints.id, id)).all()[0];
    if (!existing) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'Endpoint not found.' });
    }
    if (existing.ownerId !== user.id && user.role !== 'admin') {
      return reply.status(403).send({ code: 'FORBIDDEN', message: 'Not your endpoint.' });
    }

    // Check if any bots are using this endpoint
    const botsUsingEndpoint = db
      .select()
      .from(bots)
      .where(eq(bots.endpointId, id))
      .all();

    if (botsUsingEndpoint.length > 0) {
      return reply.status(409).send({
        code: 'ENDPOINT_IN_USE',
        message: `This endpoint is used by ${botsUsingEndpoint.length} bot(s). Remove or reassign them first.`,
      });
    }

    db.delete(llmEndpoints).where(eq(llmEndpoints.id, id)).run();

    writeAudit({
      userId: user.id,
      action: 'llm-endpoint.delete',
      target: id,
      ip: request.ip,
    });

    return reply.status(204).send();
  });

  // ── POST /api/llm-endpoints/:id/test — test connection ──────────────────
  app.post<{ Params: { id: string } }>('/api/llm-endpoints/:id/test', async (request, reply) => {
    const user = getRequestUser(request);
    await assertCan(user, 'companion:manage');

    const { id } = request.params;
    const db = getDatabase();

    const endpoint = db.select().from(llmEndpoints).where(eq(llmEndpoints.id, id)).all()[0];
    if (!endpoint) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'Endpoint not found.' });
    }
    if (endpoint.ownerId !== user.id && user.role !== 'admin') {
      return reply.status(403).send({ code: 'FORBIDDEN', message: 'Not your endpoint.' });
    }

    const parsed = validate(testEndpointSchema, request.body ?? {}, reply);
    if (!parsed.success) return;

    // Decrypt the API key for the test
    let apiKey: string | null = null;
    if (endpoint.apiKeyEnc) {
      try {
        apiKey = decryptApiKey(endpoint.apiKeyEnc);
      } catch {
        return reply.status(500).send({
          code: 'KEY_DECRYPT_ERROR',
          message: 'Could not decrypt the stored API key.',
        });
      }
    }

    const extraHeaders = endpoint.headersJson
      ? (JSON.parse(endpoint.headersJson) as Record<string, string>)
      : {};

    const model = parsed.data.model ?? endpoint.defaultModel;

    const result = await testConnection(
      endpoint.baseUrl,
      apiKey,
      model ?? null,
      extraHeaders,
      endpoint.timeoutS,
    );

    // Update supportsTools based on the test result
    db.update(llmEndpoints)
      .set({ supportsTools: result.supportsTools })
      .where(eq(llmEndpoints.id, id))
      .run();

    return reply.send(result);
  });

  // ── GET /api/servers/:id/companion/usage — usage stats ──────────────────
  app.get<{ Params: { id: string } }>('/api/servers/:id/companion/usage', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:view', serverId);

    const db = getDatabase();
    const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    if (!bot) {
      return reply.send({ configured: false });
    }

    const usage = db
      .select()
      .from(botUsage)
      .where(and(eq(botUsage.botId, bot.id), eq(botUsage.day, new Date().toISOString().slice(0, 10))))
      .all();

    const todayUsage = usage[0] ?? { promptTokens: 0, completionTokens: 0, requests: 0 };

    return reply.send({
      configured: true,
      botId: bot.id,
      status: bot.status,
      dailyBudget: bot.dailyTokenBudget,
      rpmLimit: bot.rpmLimit,
      today: {
        promptTokens: todayUsage.promptTokens,
        completionTokens: todayUsage.completionTokens,
        totalTokens: todayUsage.promptTokens + todayUsage.completionTokens,
        requests: todayUsage.requests,
      },
    });
  });

  // ── GET /api/servers/:id/companion/traces — recent traces ───────────────
  app.get<{ Params: { id: string } }>('/api/servers/:id/companion/traces', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:view', serverId);

    const db = getDatabase();
    const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    if (!bot) {
      return reply.send({ traces: [] });
    }

    const traces = db
      .select()
      .from(botTraces)
      .where(eq(botTraces.botId, bot.id))
      .orderBy(botTraces.ts)
      .limit(50)
      .all();

    return reply.send({
      traces: traces.map((t) => ({
        id: t.id,
        ts: t.ts,
        latencyMs: t.latencyMs,
        status: t.status,
        request: t.requestJson ? JSON.parse(t.requestJson) : null,
        response: t.responseJson ? JSON.parse(t.responseJson) : null,
      })),
    });
  });

  // ── POST /api/servers/:id/companion/token — generate bot token ──────────
  // (Internal: used when spawning the bot-runner container)
  app.post<{ Params: { id: string } }>('/api/servers/:id/companion/token', async (request, reply) => {
    const user = getRequestUser(request);
    const { id: serverId } = request.params;
    await assertCan(user, 'companion:spawn', serverId);

    const db = getDatabase();
    const bot = db.select().from(bots).where(eq(bots.serverId, serverId)).all()[0];
    if (!bot) {
      return reply.status(404).send({
        code: 'NO_BOT',
        message: 'No companion bot configured for this server.',
      });
    }

    const token = createBotToken(bot.id);

    writeAudit({
      userId: user.id,
      action: 'companion.token',
      target: serverId,
      ip: request.ip,
    });

    return reply.send({ token, expiresIn: 86400 });
  });
}
