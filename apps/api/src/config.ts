import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const envSchema = z.object({
  /** Port for the Fastify API server */
  PORT: z.coerce.number().default(3001),

  /** Node environment */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** Secret for JWT/session signing */
  PANEL_SECRET: z.string().min(16, 'PANEL_SECRET must be at least 16 characters'),

  /** Path to the data directory (SQLite, server volumes, backups) */
  DATA_DIR: z.string().default('./data'),

  /** Port range for game servers (inclusive) */
  PORT_RANGE: z
    .string()
    .default('25000-29999')
    .transform((val) => {
      const [start, end] = val.split('-').map(Number);
      if (!start || !end || start >= end) {
        throw new Error('PORT_RANGE must be in format "start-end" (e.g. 25000-29999)');
      }
      return { start, end };
    }),

  /** Maximum percentage of host RAM to allocate across all game servers */
  HOST_RAM_BUDGET_PCT: z.coerce.number().min(10).max(100).default(85),

  /** Log level */
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /** Allow LLM endpoints pointing to private IPs (for local Ollama etc.) */
  ALLOW_PRIVATE_LLM_ENDPOINTS: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),

  /** Bot-runner Docker image */
  BOT_RUNNER_IMAGE: z
    .string()
    .default(process.env.BOT_RUNNER_IMAGE || 'hypertextassassin/vaultrealm-bot-runner:latest'),

  /** Whether session cookies require HTTPS ('true', 'false', or 'auto' based on request protocol) */
  COOKIE_SECURE: z.enum(['true', 'false', 'auto']).default('auto'),

  /** Base URL for panel gateway reachable by containers */
  PANEL_GATEWAY_URL: z.string().default('http://host.docker.internal:3001'),

  /** Frontend origin for CORS */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  /** Google OAuth Client ID for Google Drive backups */
  GOOGLE_CLIENT_ID: z.string().optional(),

  /** Google OAuth Client Secret for Google Drive backups */
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /** Alias for Google OAuth Client ID */
  CLIENT_ID: z.string().optional(),

  /** Alias for Google OAuth Client Secret */
  CLIENT_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

/**
 * Parse and validate environment variables. Caches the result.
 * In tests, pass overrides to avoid needing real env vars.
 */
export function loadConfig(overrides?: Record<string, string>): Config {
  const isExplicitOverrides = overrides !== undefined;
  const source: Record<string, unknown> = { ...(overrides ?? process.env) };

  // When running normally (without unit test overrides), ensure PANEL_SECRET is persistent
  if (!isExplicitOverrides) {
    const rawSecret = typeof source.PANEL_SECRET === 'string' ? source.PANEL_SECRET.trim() : '';
    const dataDir = typeof source.DATA_DIR === 'string' && source.DATA_DIR.trim() ? source.DATA_DIR.trim() : './data';
    const secretFile = path.resolve(dataDir, '.panel_secret');

    if (!rawSecret || rawSecret.length < 16) {
      // 1. Try reading existing secret from persistent data directory
      if (fs.existsSync(secretFile)) {
        try {
          const stored = fs.readFileSync(secretFile, 'utf8').trim();
          if (stored.length >= 16) {
            source.PANEL_SECRET = stored;
          }
        } catch {
          // ignore read error
        }
      }

      // 2. Auto-generate and persist if still missing
      if (!source.PANEL_SECRET || (typeof source.PANEL_SECRET === 'string' && source.PANEL_SECRET.length < 16)) {
        const generated = crypto.randomBytes(32).toString('hex');
        source.PANEL_SECRET = generated;
        try {
          if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
          }
          fs.writeFileSync(secretFile, generated, { mode: 0o600 });
        } catch (err) {
          console.warn('[config] Could not persist generated PANEL_SECRET:', err);
        }
      }
    } else {
      // If PANEL_SECRET was provided via env, ensure it is also saved in .panel_secret for persistence
      try {
        if (!fs.existsSync(secretFile)) {
          if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
          }
          fs.writeFileSync(secretFile, rawSecret, { mode: 0o600 });
        }
      } catch {
        // ignore
      }
    }
  }

  const result = envSchema.safeParse(source);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${formatted}`);
  }

  _config = result.data;
  return _config;
}

/**
 * Get the cached config. Throws if loadConfig() hasn't been called.
 */
export function getConfig(): Config {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return _config;
}

/**
 * Reset cached config (for tests).
 */
export function resetConfig(): void {
  _config = null;
}
