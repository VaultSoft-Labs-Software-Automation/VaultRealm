import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ──────────────────────────────────────────────────────────────────────────────
// Users
// ──────────────────────────────────────────────────────────────────────────────
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    quotaServers: integer('quota_servers').notNull().default(3),
    quotaRamMb: integer('quota_ram_mb').notNull().default(8192),
    quotaCpu: integer('quota_cpu').notNull().default(4),
    quotaDiskMb: integer('quota_disk_mb').notNull().default(51200),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    uniqueIndex('users_email_idx').on(table.email),
    uniqueIndex('users_username_idx').on(table.username),
  ],
);

// ──────────────────────────────────────────────────────────────────────────────
// Invites
// ──────────────────────────────────────────────────────────────────────────────
export const invites = sqliteTable(
  'invites',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    maxUses: integer('max_uses').notNull().default(1),
    uses: integer('uses').notNull().default(0),
    expiresAt: text('expires_at'),
    quotaPreset: text('quota_preset'),
  },
  (table) => [uniqueIndex('invites_code_idx').on(table.code)],
);

// ──────────────────────────────────────────────────────────────────────────────
// Servers
// ──────────────────────────────────────────────────────────────────────────────
export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  templateId: text('template_id').notNull(),
  containerId: text('container_id'),
  status: text('status', {
    enum: [
      'creating',
      'pulling',
      'starting',
      'running',
      'stopping',
      'stopped',
      'crashed',
      'error',
    ],
  })
    .notNull()
    .default('creating'),
  ramMb: integer('ram_mb').notNull(),
  cpuLimit: integer('cpu_limit').notNull().default(1),
  diskLimitMb: integer('disk_limit_mb').notNull().default(10240),
  envJson: text('env_json').notNull().default('{}'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  lastStartedAt: text('last_started_at'),
  autoStopIdleMin: integer('auto_stop_idle_min'),
  restartCron: text('restart_cron'),
  publicListing: integer('public_listing', { mode: 'boolean' }).notNull().default(false),
});

// ──────────────────────────────────────────────────────────────────────────────
// Server ports
// ──────────────────────────────────────────────────────────────────────────────
export const serverPorts = sqliteTable(
  'server_ports',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id),
    name: text('name').notNull(),
    hostPort: integer('host_port').notNull(),
    containerPort: integer('container_port').notNull(),
    protocol: text('protocol', { enum: ['tcp', 'udp'] })
      .notNull()
      .default('tcp'),
  },
  (table) => [uniqueIndex('server_ports_host_protocol_idx').on(table.hostPort, table.protocol)],
);

// ──────────────────────────────────────────────────────────────────────────────
// Server members (sub-users)
// ──────────────────────────────────────────────────────────────────────────────
export const serverMembers = sqliteTable('server_members', {
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  permissionsJson: text('permissions_json').notNull().default('{}'),
});

// ──────────────────────────────────────────────────────────────────────────────
// Events (lifecycle + docker events — the debug timeline)
// ──────────────────────────────────────────────────────────────────────────────
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id),
  ts: text('ts')
    .notNull()
    .default(sql`(datetime('now'))`),
  kind: text('kind').notNull(),
  message: text('message').notNull(),
  dataJson: text('data_json'),
});

// ──────────────────────────────────────────────────────────────────────────────
// Diagnoses
// ──────────────────────────────────────────────────────────────────────────────
export const diagnoses = sqliteTable('diagnoses', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id),
  ts: text('ts')
    .notNull()
    .default(sql`(datetime('now'))`),
  ruleId: text('rule_id').notNull(),
  severity: text('severity', { enum: ['info', 'warn', 'error'] }).notNull(),
  title: text('title').notNull(),
  explanation: text('explanation').notNull(),
  fixJson: text('fix_json'),
});

// ──────────────────────────────────────────────────────────────────────────────
// Backups
// ──────────────────────────────────────────────────────────────────────────────
export const backups = sqliteTable('backups', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  sizeBytes: integer('size_bytes').notNull(),
  path: text('path').notNull(),
  kind: text('kind', { enum: ['manual', 'scheduled'] })
    .notNull()
    .default('manual'),
  name: text('name'),
  gdriveFileId: text('gdrive_file_id'),
  gdriveWebLink: text('gdrive_web_link'),
});

// ──────────────────────────────────────────────────────────────────────────────
// System Settings (key-value store for global configs like Google Drive OAuth)
// ──────────────────────────────────────────────────────────────────────────────
export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// Audit log
// ──────────────────────────────────────────────────────────────────────────────
export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  ts: text('ts')
    .notNull()
    .default(sql`(datetime('now'))`),
  userId: text('user_id').references(() => users.id),
  action: text('action').notNull(),
  target: text('target'),
  ip: text('ip'),
  dataJson: text('data_json'),
});

// ──────────────────────────────────────────────────────────────────────────────
// AI Companion — LLM Endpoints (Phase 6)
// ──────────────────────────────────────────────────────────────────────────────
export const llmEndpoints = sqliteTable('llm_endpoints', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => users.id),
  scope: text('scope', { enum: ['user', 'shared'] })
    .notNull()
    .default('user'),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKeyEnc: text('api_key_enc'),
  defaultModel: text('default_model'),
  headersJson: text('headers_json'),
  supportsTools: integer('supports_tools', { mode: 'boolean' }).notNull().default(true),
  timeoutS: integer('timeout_s').notNull().default(30),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// AI Companion — Bots (Phase 6)
// ──────────────────────────────────────────────────────────────────────────────
export const bots = sqliteTable('bots', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => servers.id)
    .unique(),
  endpointId: text('endpoint_id')
    .notNull()
    .references(() => llmEndpoints.id),
  model: text('model'),
  name: text('name').notNull().default('Buddy'),
  persona: text('persona').notNull().default('helpful friend'),
  mode: text('mode', { enum: ['off', 'manual', 'auto-solo', 'always'] })
    .notNull()
    .default('off'),
  authMode: text('auth_mode', { enum: ['offline', 'microsoft', 'proxy'] })
    .notNull()
    .default('offline'),
  whoCanCommand: text('who_can_command').notNull().default('owner'),
  permissionsJson: text('permissions_json').notNull().default('{}'),
  protectedZonesJson: text('protected_zones_json').notNull().default('[]'),
  proactive: integer('proactive', { mode: 'boolean' }).notNull().default(false),
  dailyTokenBudget: integer('daily_token_budget').notNull().default(200000),
  rpmLimit: integer('rpm_limit').notNull().default(10),
  status: text('status', { enum: ['offline', 'joining', 'online', 'error'] })
    .notNull()
    .default('offline'),
  containerId: text('container_id'),
  lastSpawnedAt: text('last_spawned_at'),
  lastDespawnedAt: text('last_despawned_at'),
  errorMessage: text('error_message'),
  msTokenEnc: text('ms_token_enc'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// AI Companion — Bot usage tracking
// ──────────────────────────────────────────────────────────────────────────────
export const botUsage = sqliteTable('bot_usage', {
  botId: text('bot_id')
    .notNull()
    .references(() => bots.id),
  day: text('day').notNull(),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  requests: integer('requests').notNull().default(0),
});

// ──────────────────────────────────────────────────────────────────────────────
// AI Companion — Bot memory (long-term per-bot state)
// ──────────────────────────────────────────────────────────────────────────────
export const botMemory = sqliteTable('bot_memory', {
  botId: text('bot_id')
    .notNull()
    .references(() => bots.id),
  key: text('key').notNull(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ──────────────────────────────────────────────────────────────────────────────
// AI Companion — Bot traces (redacted request/response log)
// ──────────────────────────────────────────────────────────────────────────────
export const botTraces = sqliteTable('bot_traces', {
  id: text('id').primaryKey(),
  botId: text('bot_id')
    .notNull()
    .references(() => bots.id),
  ts: text('ts')
    .notNull()
    .default(sql`(datetime('now'))`),
  requestJson: text('request_json'),
  responseJson: text('response_json'),
  latencyMs: integer('latency_ms'),
  status: text('status'),
});

// ──────────────────────────────────────────────────────────────────────────────
// AI Companion — Bot player roles
// ──────────────────────────────────────────────────────────────────────────────
export const botPlayers = sqliteTable('bot_players', {
  botId: text('bot_id')
    .notNull()
    .references(() => bots.id),
  playerName: text('player_name').notNull(),
  role: text('role', { enum: ['owner', 'trusted', 'guest'] })
    .notNull()
    .default('guest'),
});
