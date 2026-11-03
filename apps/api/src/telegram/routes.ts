/**
 * Fastify routes for Telegram bot integration and settings management.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, getRequestUser } from '../auth/middleware.js';
import { assertCan } from '../auth/rbac.js';
import type { TelegramUpdate } from './types.js';
import {
  getPublicTelegramConfig,
  saveTelegramConfig,
  testTelegramToken,
  processTelegramUpdate,
  getStoredTelegramConfig,
} from './service.js';

const telegramConfigSchema = z.object({
  token: z.string().optional(),
  enabled: z.boolean().optional(),
  allowedChatIds: z.array(z.string()).optional(),
  notificationsEnabled: z.boolean().optional(),
});

const testTokenSchema = z.object({
  token: z.string().min(1, 'Telegram bot token is required.'),
});

const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
}).passthrough();

export const telegramRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /api/system/telegram ──────────────────────────────────────────────
  app.get(
    '/api/system/telegram',
    { preHandler: [requireAuth] },
    async (request) => {
      const user = getRequestUser(request);
      await assertCan(user, 'admin:system');
      return getPublicTelegramConfig();
    },
  );

  // ── PUT /api/system/telegram ──────────────────────────────────────────────
  app.put<{ Body: unknown }>(
    '/api/system/telegram',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = getRequestUser(request);
      await assertCan(user, 'admin:system');

      const parsed = telegramConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid Telegram configuration data.',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      try {
        const config = await saveTelegramConfig(parsed.data, user.id, request.ip);
        return reply.send({
          message: 'Telegram configuration saved successfully.',
          config,
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        const typedError = err as { statusCode?: number; code?: string };
        const statusCode = typedError.statusCode || 400;
        return reply.status(statusCode).send({
          code: typedError.code || 'TELEGRAM_CONFIG_ERROR',
          message: error.message || 'Failed to save Telegram configuration.',
        });
      }
    },
  );

  // ── POST /api/system/telegram/test ────────────────────────────────────────
  app.post<{ Body: unknown }>(
    '/api/system/telegram/test',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = getRequestUser(request);
      await assertCan(user, 'admin:system');

      const parsed = testTokenSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Telegram bot token is required.',
          details: parsed.error.issues.map((i) => i.message),
        });
      }

      const result = await testTelegramToken(parsed.data.token);
      if (!result.ok) {
        return reply.status(400).send({
          code: 'INVALID_TELEGRAM_TOKEN',
          message: result.error || 'Invalid Telegram bot token.',
        });
      }

      return reply.send(result);
    },
  );

  // ── POST /api/system/telegram/toggle ──────────────────────────────────────
  app.post(
    '/api/system/telegram/toggle',
    { preHandler: [requireAuth] },
    async (request) => {
      const user = getRequestUser(request);
      await assertCan(user, 'admin:system');

      const current = getStoredTelegramConfig();
      const newEnabled = !(current?.enabled ?? false);
      const config = await saveTelegramConfig({ enabled: newEnabled }, user.id, request.ip);

      return {
        message: `Telegram bot management ${newEnabled ? 'enabled' : 'disabled'}.`,
        config,
      };
    },
  );

  // ── POST /api/system/telegram/webhook (Optional webhook receiver) ──────────
  app.post<{ Body: unknown }>(
    '/api/system/telegram/webhook',
    async (request, reply) => {
      const parsedUpdate = telegramUpdateSchema.safeParse(request.body);
      if (!parsedUpdate.success) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid Telegram update payload.' });
      }
      const update = parsedUpdate.data as TelegramUpdate;
      const configuredWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
      if (configuredWebhookSecret && request.headers['x-telegram-bot-api-secret-token'] !== configuredWebhookSecret) {
        return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Invalid Telegram webhook secret.' });
      }
      if (update && typeof update === 'object') {
        // Asynchronously process without blocking webhook response
        processTelegramUpdate(update).catch((err) => {
          request.log.error({ err }, '[TelegramWebhook] Error processing update');
        });
      }
      return reply.status(200).send({ ok: true });
    },
  );
};
