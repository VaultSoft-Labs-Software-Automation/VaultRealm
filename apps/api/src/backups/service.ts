/**
 * Backup and Restore service for VaultRealm game servers & full system.
 *
 * Supports creating .tar.gz compressed snapshots, live stop-less Minecraft flushes,
 * archive verification, in-place restore, retention, and seamless Google Drive cloud offload.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { nanoid } from 'nanoid';
import { eq, desc } from 'drizzle-orm';
import { getDatabase } from '../db/index.js';
import { servers, backups } from '../db/schema.js';
import { getConfig } from '../config.js';
import { getServerDataDir } from '../servers/volume.js';
import { getDockerDriver } from '../servers/service.js';
import { executeServerCommand } from '../servers/console.js';
import { getTemplate } from '../servers/templates.js';
import { writeAudit } from '../audit/log.js';
import {
  uploadToGoogleDrive,
  downloadFromGoogleDrive,
  deleteFromGoogleDrive,
} from './gdrive.js';

export interface BackupDetail {
  id: string;
  serverId: string;
  name: string | null;
  createdAt: string;
  sizeBytes: number;
  path: string;
  kind: 'manual' | 'scheduled';
  gdriveFileId: string | null;
  gdriveWebLink: string | null;
  localExists: boolean;
  gdriveSynced: boolean;
}

export interface SystemBackupDetail {
  id: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
  path: string;
  gdriveFileId?: string;
  gdriveWebLink?: string;
}

function makeError(statusCode: number, code: string, message: string): Error & { statusCode: number; code: string } {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Return absolute path to the global backups directory, ensuring it exists.
 */
export function getBackupsDir(): string {
  const config = getConfig();
  const dir = path.resolve(config.DATA_DIR, 'backups');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Create a compressed backup archive of a game server.
 */
export async function createServerBackup(
  serverId: string,
  userId: string,
  opts: { name?: string; uploadToDrive?: boolean },
  ip?: string,
): Promise<BackupDetail> {
  const db = getDatabase();
  const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
  if (!server) {
    throw makeError(404, 'NOT_FOUND', 'Server not found.');
  }

  const serverDir = getServerDataDir(serverId);
  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
  }

  // Stop-less safety for running Minecraft servers: flush chunks via RCON
  const isRunning = server.status === 'running' && server.containerId;
  const isMinecraft = server.templateId.includes('minecraft');
  if (isRunning && isMinecraft) {
    try {
      await executeServerCommand(serverId, userId, 'save-off', ip).catch(() => {});
      await executeServerCommand(serverId, userId, 'save-all flush', ip).catch(() => {});
    } catch {
      // Best-effort flush
    }
  }

  const backupId = nanoid();
  const sanitizedServerName = server.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${sanitizedServerName}_${backupId}.tar.gz`;
  const backupPath = path.join(getBackupsDir(), filename);

  try {
    // Create gzip tar archive from server directory contents
    await tar.create(
      {
        gzip: true,
        file: backupPath,
        cwd: serverDir,
      },
      fs.readdirSync(serverDir),
    );
  } finally {
    // Always re-enable auto-save on Minecraft servers
    if (isRunning && isMinecraft) {
      try {
        await executeServerCommand(serverId, userId, 'save-on', ip).catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  const stat = await fs.promises.stat(backupPath);
  const now = new Date().toISOString();

  // 1. Save local backup record immediately to guarantee persistence and prevent proxy timeouts
  db.insert(backups)
    .values({
      id: backupId,
      serverId,
      createdAt: now,
      sizeBytes: stat.size,
      path: backupPath,
      kind: 'manual',
      name: opts.name || null,
      gdriveFileId: null,
      gdriveWebLink: null,
    })
    .run();

  writeAudit({
    userId,
    action: 'server.backup.create',
    target: serverId,
    ip,
    data: { backupId, sizeBytes: stat.size, gdriveRequested: !!opts.uploadToDrive },
  });

  // 2. Offload to Google Drive in the background if requested so the HTTP request completes immediately
  if (opts.uploadToDrive) {
    void (async () => {
      try {
        const template = getTemplate(server.templateId);
        let dockerImage = template?.image;
        if (!dockerImage && server.containerId) {
          try {
            const driver = getDockerDriver();
            const info = await driver.inspectContainer(server.containerId);
            dockerImage = info.image;
          } catch {
            // ignore
          }
        }
        if (!dockerImage) {
          dockerImage = server.templateId;
        }

        const gdrive = await uploadToGoogleDrive({
          filename,
          filePath: backupPath,
          description: `VaultRealm Backup: ${server.name} (${backupId})`,
          image: dockerImage,
        });
        db.update(backups)
          .set({
            gdriveFileId: gdrive.fileId,
            gdriveWebLink: gdrive.webViewLink || null,
          })
          .where(eq(backups.id, backupId))
          .run();
        console.log(`[backups] Background Google Drive upload succeeded for ${backupId}`);
      } catch (err) {
        console.warn(`[backups] Background Google Drive upload failed for ${backupId}:`, err);
      }
    })();
  }

  return {
    id: backupId,
    serverId,
    name: opts.name || null,
    createdAt: now,
    sizeBytes: stat.size,
    path: backupPath,
    kind: 'manual',
    gdriveFileId: null,
    gdriveWebLink: null,
    localExists: true,
    gdriveSynced: false,
  };
}

/**
 * List all backups for a given server.
 */
export async function listServerBackups(serverId: string): Promise<BackupDetail[]> {
  const db = getDatabase();
  const rows = db
    .select()
    .from(backups)
    .where(eq(backups.serverId, serverId))
    .orderBy(desc(backups.createdAt))
    .all();

  return rows.map((b) => ({
    id: b.id,
    serverId: b.serverId,
    name: b.name ?? null,
    createdAt: b.createdAt,
    sizeBytes: b.sizeBytes,
    path: b.path,
    kind: b.kind,
    gdriveFileId: b.gdriveFileId ?? null,
    gdriveWebLink: b.gdriveWebLink ?? null,
    localExists: fs.existsSync(b.path),
    gdriveSynced: !!b.gdriveFileId,
  }));
}

/**
 * Restore a server to a previous backup snapshot.
 */
export async function restoreServerBackup(
  serverId: string,
  backupId: string,
  userId: string,
  ip?: string,
): Promise<void> {
  const db = getDatabase();
  const driver = getDockerDriver();

  const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
  if (!server) {
    throw makeError(404, 'NOT_FOUND', 'Server not found.');
  }

  const backup = db.select().from(backups).where(eq(backups.id, backupId)).all()[0];
  if (!backup || backup.serverId !== serverId) {
    throw makeError(404, 'NOT_FOUND', 'Backup snapshot not found.');
  }

  // If local file is missing but exists on Google Drive, pull it down first
  if (!fs.existsSync(backup.path)) {
    if (backup.gdriveFileId) {
      await downloadFromGoogleDrive(backup.gdriveFileId, backup.path);
    } else {
      throw makeError(404, 'NOT_FOUND', 'Backup file does not exist locally or on Google Drive.');
    }
  }

  const wasRunning = server.status === 'running' && server.containerId;

  // Stop container before replacing files to prevent state corruption
  if (server.containerId) {
    try {
      await driver.stopContainer(server.containerId, 10);
    } catch {
      // ignore if already stopped
    }
  }

  const serverDir = getServerDataDir(serverId);
  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
  }

  // Extract snapshot over the target server directory
  await tar.extract({
    file: backup.path,
    cwd: serverDir,
  });

  // Restart container if it was running previously
  if (wasRunning && server.containerId) {
    try {
      await driver.startContainer(server.containerId);
      db.update(servers).set({ status: 'running' }).where(eq(servers.id, serverId)).run();
    } catch (err) {
      console.warn(`[backups] Could not restart container after restore for ${serverId}:`, err);
    }
  }

  writeAudit({
    userId,
    action: 'server.backup.restore',
    target: serverId,
    ip,
    data: { backupId, filename: path.basename(backup.path) },
  });
}

/**
 * Delete a server backup locally and from Google Drive.
 */
export async function deleteServerBackup(
  serverId: string,
  backupId: string,
  userId: string,
  ip?: string,
): Promise<void> {
  const db = getDatabase();
  const backup = db.select().from(backups).where(eq(backups.id, backupId)).all()[0];
  if (!backup || backup.serverId !== serverId) {
    throw makeError(404, 'NOT_FOUND', 'Backup not found.');
  }

  // 1. Delete from Google Drive if synced
  if (backup.gdriveFileId) {
    await deleteFromGoogleDrive(backup.gdriveFileId).catch(() => {});
  }

  // 2. Delete local archive file if present
  if (fs.existsSync(backup.path)) {
    try {
      await fs.promises.unlink(backup.path);
    } catch {
      // ignore transient delete issue
    }
  }

  // 3. Delete database record
  db.delete(backups).where(eq(backups.id, backupId)).run();

  writeAudit({
    userId,
    action: 'server.backup.delete',
    target: serverId,
    ip,
    data: { backupId },
  });
}

/**
 * Upload an existing local backup to Google Drive on demand.
 */
export async function uploadBackupToDrive(
  serverId: string,
  backupId: string,
  userId: string,
  ip?: string,
): Promise<BackupDetail> {
  const db = getDatabase();
  const backup = db.select().from(backups).where(eq(backups.id, backupId)).all()[0];
  if (!backup || backup.serverId !== serverId) {
    throw makeError(404, 'NOT_FOUND', 'Backup not found.');
  }

  if (!fs.existsSync(backup.path)) {
    throw makeError(400, 'FILE_MISSING', 'Local backup archive does not exist on disk.');
  }

  const server = db.select().from(servers).where(eq(servers.id, serverId)).all()[0];
  const template = server ? getTemplate(server.templateId) : undefined;
  let dockerImage = template?.image;
  if (!dockerImage && server?.containerId) {
    try {
      const driver = getDockerDriver();
      const info = await driver.inspectContainer(server.containerId);
      dockerImage = info.image;
    } catch {
      // ignore
    }
  }
  if (!dockerImage) {
    dockerImage = server?.templateId || 'server';
  }

  const gdrive = await uploadToGoogleDrive({
    filename: path.basename(backup.path),
    filePath: backup.path,
    description: `VaultRealm Backup: ${server?.name || serverId} (${backupId})`,
    image: dockerImage,
  });

  db.update(backups)
    .set({
      gdriveFileId: gdrive.fileId,
      gdriveWebLink: gdrive.webViewLink || null,
    })
    .where(eq(backups.id, backupId))
    .run();

  writeAudit({
    userId,
    action: 'server.backup.upload_drive',
    target: serverId,
    ip,
    data: { backupId, gdriveFileId: gdrive.fileId },
  });

  return {
    id: backup.id,
    serverId: backup.serverId,
    name: backup.name ?? null,
    createdAt: backup.createdAt,
    sizeBytes: backup.sizeBytes,
    path: backup.path,
    kind: backup.kind,
    gdriveFileId: gdrive.fileId,
    gdriveWebLink: gdrive.webViewLink || null,
    localExists: true,
    gdriveSynced: true,
  };
}

/**
 * Create a full panel disaster recovery backup (panel.db + all metadata).
 */
export async function createFullSystemBackup(
  userId: string,
  opts: { uploadToDrive?: boolean },
  ip?: string,
): Promise<SystemBackupDetail> {
  const config = getConfig();
  const dbPath = path.resolve(config.DATA_DIR, 'panel.db');
  if (!fs.existsSync(dbPath)) {
    throw makeError(404, 'NOT_FOUND', 'Panel database not found.');
  }

  const id = nanoid();
  const timestamp = Date.now();
  const filename = `vaultrealm_full_system_${timestamp}_${id}.tar.gz`;
  const backupPath = path.join(getBackupsDir(), filename);

  // Backup data directory containing SQLite database and configurations
  const filesToInclude = ['panel.db'];
  if (fs.existsSync(path.resolve(config.DATA_DIR, 'panel.db-wal'))) {
    filesToInclude.push('panel.db-wal');
  }
  if (fs.existsSync(path.resolve(config.DATA_DIR, 'panel.db-shm'))) {
    filesToInclude.push('panel.db-shm');
  }

  await tar.create(
    {
      gzip: true,
      file: backupPath,
      cwd: config.DATA_DIR,
    },
    filesToInclude,
  );

  const stat = await fs.promises.stat(backupPath);
  const now = new Date().toISOString();

  let gdriveFileId: string | undefined;
  let gdriveWebLink: string | undefined;

  if (opts.uploadToDrive) {
    try {
      const gdrive = await uploadToGoogleDrive({
        filename,
        filePath: backupPath,
        description: 'VaultRealm Full Panel System Disaster Recovery Backup',
        image: 'vaultrealm-system',
      });
      gdriveFileId = gdrive.fileId;
      gdriveWebLink = gdrive.webViewLink;
    } catch (err) {
      console.warn('[backups] System backup Google Drive upload failed:', err);
    }
  }

  writeAudit({
    userId,
    action: 'system.backup.create',
    target: 'system',
    ip,
    data: { id, filename, sizeBytes: stat.size, gdriveSynced: !!gdriveFileId },
  });

  return {
    id,
    filename,
    createdAt: now,
    sizeBytes: stat.size,
    path: backupPath,
    gdriveFileId,
    gdriveWebLink,
  };
}

/**
 * List all full system disaster recovery backups on disk.
 */
export async function listSystemBackups(): Promise<SystemBackupDetail[]> {
  const dir = getBackupsDir();
  const files = await fs.promises.readdir(dir);
  const systemFiles = files.filter((f) => f.startsWith('vaultrealm_full_system_') && f.endsWith('.tar.gz'));

  const details: SystemBackupDetail[] = [];
  for (const filename of systemFiles) {
    const fullPath = path.join(dir, filename);
    const stat = await fs.promises.stat(fullPath);
    details.push({
      id: filename.replace('.tar.gz', ''),
      filename,
      createdAt: stat.birthtime.toISOString(),
      sizeBytes: stat.size,
      path: fullPath,
    });
  }

  return details.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

