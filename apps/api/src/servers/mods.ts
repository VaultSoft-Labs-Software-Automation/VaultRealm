/**
 * Mods and plugins manager for game servers.
 *
 * Interacts with the server's storage volume using safepath.resolve().
 * Supports listing, downloading from Modrinth / trusted URLs, toggling (.disabled), and deletion.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getServerDataDir } from './volume.js';
import { safepath } from '../safepath.js';
import {
  installMrpack,
  isMrpackBuffer,
  getInstalledModpack,
  type InstallMrpackResult,
  type InstalledModpackInfo,
} from './mrpack.js';

export { getInstalledModpack, type InstalledModpackInfo, type InstallMrpackResult };

export interface InstalledMod {
  filename: string;
  sizeBytes: number;
  enabled: boolean;
  modifiedAt: string;
}

export type InstallModResult =
  | {
      isMrpack?: false;
      filename: string;
      sizeBytes: number;
    }
  | (InstallMrpackResult & {
      filename: string;
      sizeBytes: number;
    });

export function getAddonsFolder(templateId: string): string {
  // Paper, Purpur, Spigot use 'plugins', while Fabric, Forge, NeoForge, Quilt use 'mods'
  const isPluginServer = ['paper', 'spigot', 'purpur'].some((k) => templateId.toLowerCase().includes(k));
  return isPluginServer ? 'plugins' : 'mods';
}

export function detectServerGameVersion(serverId: string, _templateId: string): string | null {
  const serverDir = getServerDataDir(serverId);
  if (!fs.existsSync(serverDir)) return null;

  // 1. Check .fabric-manifest.json
  const fabricManifestPath = safepath.resolve(serverDir, '.fabric-manifest.json');
  if (fs.existsSync(fabricManifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(fabricManifestPath, 'utf8'));
      if (manifest?.origin?.game) {
        return String(manifest.origin.game);
      }
    } catch {
      // ignore
    }
  }

  // 2. Check for server launcher jar (e.g. fabric-server-mc.26.3-loader.0.20.1-launcher.1.1.2.jar)
  try {
    const files = fs.readdirSync(serverDir);
    for (const f of files) {
      const fabricMatch = f.match(/fabric-server-mc\.([0-9a-zA-Z.-]+)-loader/);
      if (fabricMatch && fabricMatch[1]) {
        return fabricMatch[1];
      }
      const paperMatch = f.match(/paper-([0-9.]+)-/);
      if (paperMatch && paperMatch[1]) {
        return paperMatch[1];
      }
      const purpurMatch = f.match(/purpur-([0-9.]+)-/);
      if (purpurMatch && purpurMatch[1]) {
        return purpurMatch[1];
      }
    }
  } catch {
    // ignore
  }

  // 3. Check logs/latest.log
  const logPath = safepath.resolve(serverDir, 'logs', 'latest.log');
  if (fs.existsSync(logPath)) {
    try {
      const logContent = fs.readFileSync(logPath, 'utf8').slice(0, 8192);
      const logMatch =
        logContent.match(/Loading Minecraft ([0-9a-zA-Z.-]+)/i) ||
        logContent.match(/Starting minecraft server version ([0-9a-zA-Z.-]+)/i);
      if (logMatch && logMatch[1]) {
        return logMatch[1];
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export function getModsDirectory(serverId: string, templateId: string): string {
  const serverDir = getServerDataDir(serverId);
  const folderName = getAddonsFolder(templateId);
  const modsDir = safepath.resolve(serverDir, folderName);
  if (!fs.existsSync(modsDir)) {
    fs.mkdirSync(modsDir, { recursive: true, mode: 0o777 });
  }
  return modsDir;
}

export async function listInstalledMods(serverId: string, templateId: string): Promise<InstalledMod[]> {
  const modsDir = getModsDirectory(serverId, templateId);
  if (!fs.existsSync(modsDir)) {
    return [];
  }

  const entries = await fs.promises.readdir(modsDir, { withFileTypes: true });
  const result: InstalledMod[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isJar = entry.name.endsWith('.jar');
    const isDisabledJar = entry.name.endsWith('.jar.disabled');

    if (!isJar && !isDisabledJar) continue;

    try {
      const filePath = safepath.resolve(modsDir, entry.name);
      const stats = await fs.promises.stat(filePath);

      result.push({
        filename: entry.name,
        sizeBytes: stats.size,
        enabled: isJar,
        modifiedAt: stats.mtime.toISOString(),
      });
    } catch {
      // Ignore files that can't be stat-ed
    }
  }

  // Sort alphabetically
  return result.sort((a, b) => a.filename.localeCompare(b.filename));
}

export async function installModFromUrl(
  serverId: string,
  templateId: string,
  downloadUrl: string,
  rawFilename: string,
): Promise<InstallModResult> {
  // Validate URL protocol
  const parsed = new URL(downloadUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const error = new Error('Invalid download URL: protocol must be HTTP or HTTPS');
    (error as Error & { code: string; statusCode: number }).code = 'INVALID_PROTOCOL';
    (error as Error & { statusCode: number }).statusCode = 400;
    throw error;
  }

  const res = await fetch(downloadUrl, {
    headers: {
      'User-Agent': 'VaultRealm-Panel/0.5 (https://vaultsoftlabs.tech)',
    },
    signal: AbortSignal.timeout(30000), // 30s timeout
  });

  if (!res.ok) {
    const error = new Error(`Failed to download mod from remote server: HTTP ${res.status}`);
    (error as Error & { code: string; statusCode: number }).code = 'DOWNLOAD_FAILED';
    (error as Error & { statusCode: number }).statusCode = 502;
    throw error;
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const isMrpack =
    rawFilename.toLowerCase().endsWith('.mrpack') ||
    parsed.pathname.toLowerCase().endsWith('.mrpack') ||
    isMrpackBuffer(buffer);

  if (isMrpack) {
    const mrpackResult = await installMrpack(serverId, templateId, buffer);
    return {
      filename: rawFilename,
      sizeBytes: buffer.length,
      ...mrpackResult,
    };
  }

  // Clean filename and ensure it ends with .jar
  let filename = path.basename(rawFilename).replace(/[^a-zA-Z0-9_\-.+]/g, '_');
  if (!filename.endsWith('.jar')) {
    filename += '.jar';
  }

  const modsDir = getModsDirectory(serverId, templateId);
  const targetPath = safepath.resolve(modsDir, filename);

  await fs.promises.writeFile(targetPath, buffer);

  return {
    filename,
    sizeBytes: buffer.length,
  };
}

export async function toggleMod(
  serverId: string,
  templateId: string,
  filename: string,
  enable: boolean,
): Promise<{ newFilename: string; enabled: boolean }> {
  const modsDir = getModsDirectory(serverId, templateId);
  const currentPath = safepath.resolve(modsDir, filename);

  if (!fs.existsSync(currentPath)) {
    const error = new Error(`Mod file not found: ${filename}`);
    (error as Error & { code: string; statusCode: number }).code = 'NOT_FOUND';
    (error as Error & { statusCode: number }).statusCode = 404;
    throw error;
  }

  let newFilename = filename;
  if (enable && filename.endsWith('.jar.disabled')) {
    newFilename = filename.replace(/\.disabled$/, '');
  } else if (!enable && filename.endsWith('.jar')) {
    newFilename = `${filename}.disabled`;
  }

  if (newFilename !== filename) {
    const newPath = safepath.resolve(modsDir, newFilename);
    await fs.promises.rename(currentPath, newPath);
  }

  return {
    newFilename,
    enabled: enable,
  };
}

export async function deleteMod(
  serverId: string,
  templateId: string,
  filename: string,
): Promise<void> {
  const modsDir = getModsDirectory(serverId, templateId);
  const filePath = safepath.resolve(modsDir, filename);

  if (!fs.existsSync(filePath)) {
    const error = new Error(`Mod file not found: ${filename}`);
    (error as Error & { code: string; statusCode: number }).code = 'NOT_FOUND';
    (error as Error & { statusCode: number }).statusCode = 404;
    throw error;
  }

  await fs.promises.unlink(filePath);
}

export async function saveUploadedMod(
  serverId: string,
  templateId: string,
  rawFilename: string,
  contentBase64: string,
): Promise<InstallModResult> {
  const buffer = Buffer.from(contentBase64, 'base64');
  if (buffer.length === 0) {
    const error = new Error('Uploaded file is empty.');
    (error as Error & { code: string; statusCode: number }).code = 'EMPTY_FILE';
    (error as Error & { statusCode: number }).statusCode = 400;
    throw error;
  }

  if (buffer.length > 150 * 1024 * 1024) {
    const error = new Error('File exceeds maximum allowed size of 150 MB.');
    (error as Error & { code: string; statusCode: number }).code = 'FILE_TOO_LARGE';
    (error as Error & { statusCode: number }).statusCode = 400;
    throw error;
  }

  const isMrpack =
    rawFilename.toLowerCase().endsWith('.mrpack') ||
    isMrpackBuffer(buffer);

  if (isMrpack) {
    const mrpackResult = await installMrpack(serverId, templateId, buffer);
    return {
      filename: rawFilename,
      sizeBytes: buffer.length,
      ...mrpackResult,
    };
  }

  let filename = path.basename(rawFilename).replace(/[^a-zA-Z0-9_\-.+]/g, '_');
  if (!filename.endsWith('.jar') && !filename.endsWith('.jar.disabled')) {
    filename += '.jar';
  }

  const modsDir = getModsDirectory(serverId, templateId);
  const targetPath = safepath.resolve(modsDir, filename);

  await fs.promises.writeFile(targetPath, buffer);

  return {
    filename,
    sizeBytes: buffer.length,
  };
}
