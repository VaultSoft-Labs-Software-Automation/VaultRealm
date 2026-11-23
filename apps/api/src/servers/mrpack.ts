import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { safepath } from '../safepath.js';
import { getServerDataDir } from './volume.js';

export interface ModrinthIndexFile {
  path: string;
  hashes?: {
    sha1?: string;
    sha512?: string;
  };
  env?: {
    client?: 'required' | 'optional' | 'unsupported';
    server?: 'required' | 'optional' | 'unsupported';
  };
  downloads: string[];
  fileSize?: number;
}

export interface ModrinthIndex {
  formatVersion: number;
  game: string;
  versionId?: string;
  name: string;
  summary?: string;
  files: ModrinthIndexFile[];
  dependencies?: Record<string, string>;
}

export interface ZipEntry {
  filename: string;
  getData: () => Buffer;
}

export interface InstallMrpackResult {
  isMrpack: true;
  modpackName: string;
  versionId?: string;
  installedModsCount: number;
  installedFilesCount: number;
  skippedClientModsCount: number;
  dependencies?: Record<string, string>;
}

export interface InstalledModpackInfo {
  name: string;
  versionId?: string;
  installedAt: string;
  dependencies?: Record<string, string>;
  installedModsCount: number;
  installedFilesCount: number;
}

/**
 * Parses a ZIP archive buffer and returns all entry headers and lazy data getters.
 * Supports both uncompressed (method 0) and Deflate (method 8) formats without external dependencies.
 */
export function parseZipArchive(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) {
    throw new Error('Invalid archive: file too short to be a valid ZIP archive');
  }

  // Scan backwards to find the End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid archive: End of Central Directory signature not found');
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (cdOffset >= buffer.length) {
    throw new Error('Invalid archive: Central Directory offset points outside file buffer');
  }

  const entries: ZipEntry[] = [];
  let offset = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const filenameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);

    const filenameBytes = buffer.subarray(offset + 46, offset + 46 + filenameLen);
    const rawFilename = filenameBytes.toString('utf8').replace(/\\/g, '/');

    offset += 46 + filenameLen + extraLen + commentLen;

    const getData = (): Buffer => {
      if (rawFilename.endsWith('/')) {
        return Buffer.alloc(0);
      }
      if (localHeaderOffset + 30 > buffer.length) {
        throw new Error(`Corrupted local header for ${rawFilename}`);
      }
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`Invalid local header signature for ${rawFilename}`);
      }

      const localFnLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFnLen + localExtraLen;

      if (dataStart + compressedSize > buffer.length) {
        throw new Error(`Corrupted data block for ${rawFilename}`);
      }

      const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        return Buffer.from(compressedData);
      }
      if (compressionMethod === 8) {
        return zlib.inflateRawSync(compressedData);
      }
      throw new Error(`Unsupported compression method (${compressionMethod}) for ${rawFilename}`);
    };

    entries.push({ filename: rawFilename, getData });
  }

  return entries;
}

/**
 * Checks if a buffer represents a Modrinth .mrpack archive.
 */
export function isMrpackBuffer(buffer: Buffer): boolean {
  if (buffer.length < 22) return false;
  try {
    const entries = parseZipArchive(buffer);
    return entries.some((e) => e.filename === 'modrinth.index.json');
  } catch {
    return false;
  }
}

/**
 * Installs a Modrinth .mrpack modpack archive into the server's data volume directory.
 * Extracts overrides, server-overrides, and downloads server-compatible mod files.
 */
export async function installMrpack(
  serverId: string,
  _templateId: string,
  buffer: Buffer,
): Promise<InstallMrpackResult> {
  let entries: ZipEntry[];
  try {
    entries = parseZipArchive(buffer);
  } catch (err) {
    const error = new Error(`Invalid .mrpack archive: ${err instanceof Error ? err.message : String(err)}`);
    (error as Error & { code: string; statusCode: number }).code = 'INVALID_MRPACK';
    (error as Error & { statusCode: number }).statusCode = 400;
    throw error;
  }

  const indexEntry = entries.find((e) => e.filename === 'modrinth.index.json');

  if (!indexEntry) {
    const error = new Error('Invalid .mrpack archive: missing modrinth.index.json manifest');
    (error as Error & { code: string; statusCode: number }).code = 'INVALID_MRPACK';
    (error as Error & { statusCode: number }).statusCode = 400;
    throw error;
  }

  let index: ModrinthIndex;
  try {
    const jsonStr = indexEntry.getData().toString('utf8');
    index = JSON.parse(jsonStr) as ModrinthIndex;
  } catch (err) {
    const error = new Error(`Malformed modrinth.index.json: ${err instanceof Error ? err.message : String(err)}`);
    (error as Error & { code: string; statusCode: number }).code = 'INVALID_MANIFEST';
    (error as Error & { statusCode: number }).statusCode = 400;
    throw error;
  }

  if (index.game && index.game.toLowerCase() !== 'minecraft') {
    const error = new Error(`Unsupported game in modpack: ${index.game}. Only Minecraft modpacks are supported.`);
    (error as Error & { code: string; statusCode: number }).code = 'UNSUPPORTED_GAME';
    (error as Error & { statusCode: number }).statusCode = 400;
    throw error;
  }

  const serverDir = getServerDataDir(serverId);
  let installedFilesCount = 0;

  // 1. Extract overrides/
  for (const entry of entries) {
    if (entry.filename.startsWith('overrides/')) {
      const relPath = entry.filename.slice('overrides/'.length);
      if (!relPath || relPath.endsWith('/')) continue;
      const targetPath = safepath.resolve(serverDir, relPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o777 });
      fs.writeFileSync(targetPath, entry.getData());
      installedFilesCount++;
    }
  }

  // 2. Extract server-overrides/ (precedence over overrides/)
  for (const entry of entries) {
    if (entry.filename.startsWith('server-overrides/')) {
      const relPath = entry.filename.slice('server-overrides/'.length);
      if (!relPath || relPath.endsWith('/')) continue;
      const targetPath = safepath.resolve(serverDir, relPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o777 });
      fs.writeFileSync(targetPath, entry.getData());
      installedFilesCount++;
    }
  }

  // 3. Download and install server-compatible mods from index.files
  let installedModsCount = 0;
  let skippedClientModsCount = 0;

  const serverFiles = (index.files || []).filter((f) => {
    // Skip client-only mods (e.g. Sodium, Iris, Zoomify, GUI mods) that crash dedicated servers
    if (f.env?.server === 'unsupported') {
      skippedClientModsCount++;
      return false;
    }
    return f.downloads && f.downloads.length > 0;
  });

  // Download with concurrency limit of 5 parallel downloads
  let fileIndex = 0;
  const workers = Array.from({ length: Math.min(5, serverFiles.length) }, async () => {
    while (fileIndex < serverFiles.length) {
      const f = serverFiles[fileIndex++];
      if (!f) break;

      const targetPath = safepath.resolve(serverDir, f.path);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o777 });

      // If file already exists with same size, skip redundant network fetch
      if (fs.existsSync(targetPath)) {
        try {
          const stats = fs.statSync(targetPath);
          if (f.fileSize && stats.size === f.fileSize) {
            installedModsCount++;
            continue;
          }
        } catch {
          // re-download
        }
      }

      const downloadUrl = f.downloads[0];
      if (!downloadUrl) continue;

      try {
        const res = await fetch(downloadUrl, {
          headers: {
            'User-Agent': 'VaultRealm-Panel/0.5 (https://vaultsoftlabs.tech)',
          },
          signal: AbortSignal.timeout(30000),
        });

        if (res.ok) {
          const arrayBuffer = await res.arrayBuffer();
          fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
          installedModsCount++;
        }
      } catch (err) {
        // Log warning but continue installing other files
        console.warn(`[mrpack] Failed to download mod file ${f.path}:`, err);
      }
    }
  });

  await Promise.all(workers);

  // 4. Save installed modpack metadata
  const metaPath = safepath.resolve(serverDir, '.vaultrealm-modpack.json');
  try {
    fs.writeFileSync(
      metaPath,
      JSON.stringify(
        {
          name: index.name,
          versionId: index.versionId,
          installedAt: new Date().toISOString(),
          dependencies: index.dependencies || {},
          installedModsCount,
          installedFilesCount,
        },
        null,
        2,
      ),
    );
  } catch {
    // non-fatal
  }

  return {
    isMrpack: true,
    modpackName: index.name,
    versionId: index.versionId,
    installedModsCount,
    installedFilesCount,
    skippedClientModsCount,
    dependencies: index.dependencies,
  };
}

/**
 * Returns metadata of the currently installed modpack on this server, if any.
 */
export function getInstalledModpack(serverId: string): InstalledModpackInfo | null {
  try {
    const serverDir = getServerDataDir(serverId);
    const metaPath = safepath.resolve(serverDir, '.vaultrealm-modpack.json');
    if (!fs.existsSync(metaPath)) return null;

    const data = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return {
      name: data.name || 'Custom Modpack',
      versionId: data.versionId,
      installedAt: data.installedAt || new Date().toISOString(),
      dependencies: data.dependencies,
      installedModsCount: data.installedModsCount || 0,
      installedFilesCount: data.installedFilesCount || 0,
    };
  } catch {
    return null;
  }
}
