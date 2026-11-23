import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import * as schema from './schema.js';
import { getConfig } from '../config.js';

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

/**
 * Initialize the SQLite database connection.
 * Creates the data directory if it doesn't exist.
 */
export function initDatabase(dbPath?: string): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;

  const config = getConfig();
  const dataDir = config.DATA_DIR;
  mkdirSync(dataDir, { recursive: true });

  const resolvedPath = dbPath ?? join(dataDir, 'panel.db');
  _sqlite = new Database(resolvedPath);

  // Enable WAL mode for better concurrent read performance
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');

  _db = drizzle(_sqlite, { schema });
  return _db;
}

/**
 * Get the cached database instance. Throws if not initialized.
 */
export function getDatabase(): BetterSQLite3Database<typeof schema> {
  if (!_db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return _db;
}

/**
 * Close the database connection. Used in tests and graceful shutdown.
 */
export function closeDatabase(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

/**
 * Run the initial schema creation using raw SQL.
 * In production, use drizzle-kit migrations; this is for bootstrapping and tests.
 */
export function runMigrations(): void {
  // drizzle-kit will handle real migrations; this is a bootstrap fallback
  // that creates tables if they don't exist
  const sqlite = _sqlite;
  if (!sqlite) throw new Error('No raw SQLite connection available');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      quota_servers INTEGER NOT NULL DEFAULT 3,
      quota_ram_mb INTEGER NOT NULL DEFAULT 8192,
      quota_cpu INTEGER NOT NULL DEFAULT 4,
      quota_disk_mb INTEGER NOT NULL DEFAULT 51200,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL REFERENCES users(id),
      max_uses INTEGER NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      quota_preset TEXT
    );

    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      template_id TEXT NOT NULL,
      container_id TEXT,
      status TEXT NOT NULL DEFAULT 'creating'
        CHECK(status IN ('creating','pulling','starting','running','stopping','stopped','crashed','error')),
      ram_mb INTEGER NOT NULL,
      cpu_limit INTEGER NOT NULL DEFAULT 1,
      disk_limit_mb INTEGER NOT NULL DEFAULT 10240,
      env_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_started_at TEXT,
      auto_stop_idle_min INTEGER,
      restart_cron TEXT,
      public_listing INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS server_ports (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id),
      name TEXT NOT NULL,
      host_port INTEGER NOT NULL,
      container_port INTEGER NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'tcp' CHECK(protocol IN ('tcp', 'udp')),
      UNIQUE(host_port, protocol)
    );

    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL REFERENCES servers(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      permissions_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id),
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT
    );

    CREATE TABLE IF NOT EXISTS diagnoses (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id),
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      rule_id TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('info', 'warn', 'error')),
      title TEXT NOT NULL,
      explanation TEXT NOT NULL,
      fix_json TEXT
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      size_bytes INTEGER NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual', 'scheduled')),
      name TEXT,
      gdrive_file_id TEXT,
      gdrive_web_link TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      target TEXT,
      ip TEXT,
      data_json TEXT
    );

    CREATE TABLE IF NOT EXISTS llm_endpoints (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id),
      scope TEXT NOT NULL DEFAULT 'user' CHECK(scope IN ('user', 'shared')),
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_enc TEXT,
      default_model TEXT,
      headers_json TEXT,
      supports_tools INTEGER NOT NULL DEFAULT 1,
      timeout_s INTEGER NOT NULL DEFAULT 30,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL UNIQUE REFERENCES servers(id),
      endpoint_id TEXT NOT NULL REFERENCES llm_endpoints(id),
      model TEXT,
      name TEXT NOT NULL DEFAULT 'Buddy',
      persona TEXT NOT NULL DEFAULT 'helpful friend',
      mode TEXT NOT NULL DEFAULT 'off' CHECK(mode IN ('off','manual','auto-solo','always')),
      auth_mode TEXT NOT NULL DEFAULT 'offline' CHECK(auth_mode IN ('offline','microsoft','proxy')),
      who_can_command TEXT NOT NULL DEFAULT 'owner',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      protected_zones_json TEXT NOT NULL DEFAULT '[]',
      proactive INTEGER NOT NULL DEFAULT 0,
      daily_token_budget INTEGER NOT NULL DEFAULT 200000,
      rpm_limit INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('offline','joining','online','error')),
      container_id TEXT,
      last_spawned_at TEXT,
      last_despawned_at TEXT,
      error_message TEXT,
      ms_token_enc TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_usage (
      bot_id TEXT NOT NULL REFERENCES bots(id),
      day TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bot_id, day)
    );

    CREATE TABLE IF NOT EXISTS bot_memory (
      bot_id TEXT NOT NULL REFERENCES bots(id),
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_traces (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id),
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      request_json TEXT,
      response_json TEXT,
      latency_ms INTEGER,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS bot_players (
      bot_id TEXT NOT NULL REFERENCES bots(id),
      player_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'guest' CHECK(role IN ('owner','trusted','guest'))
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Safe migrations for newly added columns on existing databases
  try {
    sqlite.exec(`ALTER TABLE backups ADD COLUMN name TEXT;`);
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec(`ALTER TABLE backups ADD COLUMN gdrive_file_id TEXT;`);
  } catch {
    // Column already exists
  }
  try {
    sqlite.exec(`ALTER TABLE backups ADD COLUMN gdrive_web_link TEXT;`);
  } catch {
    // Column already exists
  }
}
