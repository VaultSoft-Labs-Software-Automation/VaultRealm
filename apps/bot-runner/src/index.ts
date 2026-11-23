/**
 * Entry point for the VaultRealm Bot Runner container.
 */

import { z } from 'zod';
import { CompanionBotRunner } from './bot.js';
import type { BotConfig } from './types.js';
import { setupVersionCompatibility } from './version-compat.js';

const envSchema = z.object({
  BOT_ID: z.string().min(1, 'BOT_ID is required'),
  BOT_NAME: z.string().default('Buddy'),
  SERVER_ID: z.string().default('default-server'),
  SERVER_HOST: z.string().default('localhost'),
  SERVER_PORT: z.coerce.number().default(25565),
  AUTH_MODE: z.enum(['offline', 'microsoft', 'proxy']).default('offline'),
  PERSONA: z.string().default('helpful friend'),
  PANEL_GATEWAY_URL: z.string().default('http://localhost:3001'),
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  MINECRAFT_VERSION: z.string().optional(),
  OWNER_NAME: z.string().default('admin'),
  TRUSTED_PLAYERS: z.string().optional(),
  WHO_CAN_COMMAND: z
    .string()
    .default('owner_only')
    .transform((val) => (val === 'owner' ? 'owner_only' : val))
    .pipe(z.enum(['owner_only', 'trusted', 'everyone'])),
  PROTECTED_ZONES_JSON: z.string().optional(),
  SAVED_PLACES_JSON: z.string().optional(),
  USE_JSON_FALLBACK: z.coerce.boolean().default(false),
});

function main() {
  console.log('[BotRunner] Starting VaultRealm AI Companion...');
  setupVersionCompatibility();

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    if (process.env.NODE_ENV !== 'production' && !process.env.BOT_ID) {
      console.warn('[BotRunner] Standby mode: No BOT_ID configured.');
      console.warn('[BotRunner] To test the companion bot standalone, copy .env.example to .env in apps/bot-runner.');
      return;
    }

    console.error('[BotRunner] Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  const env = parsed.data;

  let protectedZones = undefined;
  if (env.PROTECTED_ZONES_JSON) {
    try {
      protectedZones = JSON.parse(env.PROTECTED_ZONES_JSON);
    } catch {
      console.warn('[BotRunner] Failed to parse PROTECTED_ZONES_JSON');
    }
  }

  let savedPlaces = undefined;
  if (env.SAVED_PLACES_JSON) {
    try {
      savedPlaces = JSON.parse(env.SAVED_PLACES_JSON);
    } catch {
      console.warn('[BotRunner] Failed to parse SAVED_PLACES_JSON');
    }
  }

  const trustedPlayers = env.TRUSTED_PLAYERS
    ? env.TRUSTED_PLAYERS.split(',').map((p) => p.trim()).filter(Boolean)
    : [];

  const config: BotConfig = {
    botId: env.BOT_ID,
    botName: env.BOT_NAME,
    serverId: env.SERVER_ID,
    serverHost: env.SERVER_HOST,
    serverPort: env.SERVER_PORT,
    authMode: env.AUTH_MODE,
    persona: env.PERSONA,
    panelGatewayUrl: env.PANEL_GATEWAY_URL,
    botToken: env.BOT_TOKEN,
    minecraftVersion: env.MINECRAFT_VERSION,
    ownerName: env.OWNER_NAME,
    trustedPlayers,
    whoCanCommand: env.WHO_CAN_COMMAND,
    protectedZones,
    savedPlaces,
    useJsonActionFallback: env.USE_JSON_FALLBACK,
  };

  const runner = new CompanionBotRunner(config);
  runner.start();

  const shutdown = () => {
    console.log('[BotRunner] Shutting down cleanly...');
    runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
