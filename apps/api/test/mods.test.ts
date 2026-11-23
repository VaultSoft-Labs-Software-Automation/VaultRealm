import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { buildTestApp, cleanupTestApp, registerAdmin } from './helpers.js';
import { safepath } from '../src/safepath.js';
import { getModsDirectory, detectServerGameVersion } from '../src/servers/mods.js';
import { getServerDataDir } from '../src/servers/volume.js';

describe('Server Mods & Plugins Management', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let serverId: string;

  beforeEach(async () => {
    app = await buildTestApp();

    const { cookies } = await registerAdmin(app);
    adminCookie = cookies['vr_session']!;

    // Create a Fabric Minecraft server
    const serverRes = await app.inject({
      method: 'POST',
      url: '/api/servers',
      cookies: { vr_session: adminCookie },
      payload: {
        name: 'Fabric Modded Realm',
        templateId: 'minecraft-java',
        env: {
          TYPE: 'FABRIC',
          VERSION: '1.21.4',
        },
      },
    });
    serverId = serverRes.json().id;
  });

  afterEach(() => {
    cleanupTestApp();
  });

  it('safepath blocks directory traversal outside base directory', () => {
    const baseDir = process.cwd();
    expect(() => safepath.resolve(baseDir, '../../etc/passwd')).toThrow(/path traversal detected/i);
    expect(() => safepath.resolve(baseDir, 'mods', '..', '..', 'evil.jar')).toThrow(/path traversal detected/i);
    expect(safepath.resolve(baseDir, 'mods', 'safe.jar')).toContain('safe.jar');
  });

  it('GET /api/servers/:id/mods returns empty list and mods folder name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/mods`,
      cookies: { vr_session: adminCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.folder).toBe('mods');
    expect(body.mods).toEqual([]);
  });

  it('detects and lists placed mod files with enable/disable state', async () => {
    const modsDir = getModsDirectory(serverId, 'minecraft-java');
    fs.writeFileSync(`${modsDir}/sodium-fabric.jar`, 'mock jar bytes');
    fs.writeFileSync(`${modsDir}/lithium.jar.disabled`, 'mock disabled bytes');

    const res = await app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/mods`,
      cookies: { vr_session: adminCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mods).toHaveLength(2);

    const sodium = body.mods.find((m: { filename: string }) => m.filename === 'sodium-fabric.jar');
    expect(sodium).toBeDefined();
    expect(sodium!.enabled).toBe(true);

    const lithium = body.mods.find((m: { filename: string }) => m.filename === 'lithium.jar.disabled');
    expect(lithium).toBeDefined();
    expect(lithium!.enabled).toBe(false);
  });

  it('POST /api/servers/:id/mods/toggle disables and enables mods', async () => {
    const modsDir = getModsDirectory(serverId, 'minecraft-java');
    fs.writeFileSync(`${modsDir}/chunky.jar`, 'mock chunky jar');

    // Disable
    const disableRes = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/mods/toggle`,
      cookies: { vr_session: adminCookie },
      payload: {
        filename: 'chunky.jar',
        enable: false,
      },
    });

    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json().newFilename).toBe('chunky.jar.disabled');
    expect(fs.existsSync(`${modsDir}/chunky.jar.disabled`)).toBe(true);
    expect(fs.existsSync(`${modsDir}/chunky.jar`)).toBe(false);

    // Re-enable
    const enableRes = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/mods/toggle`,
      cookies: { vr_session: adminCookie },
      payload: {
        filename: 'chunky.jar.disabled',
        enable: true,
      },
    });

    expect(enableRes.statusCode).toBe(200);
    expect(enableRes.json().newFilename).toBe('chunky.jar');
    expect(fs.existsSync(`${modsDir}/chunky.jar`)).toBe(true);
  });

  it('DELETE /api/servers/:id/mods/:filename removes the mod file', async () => {
    const modsDir = getModsDirectory(serverId, 'minecraft-java');
    fs.writeFileSync(`${modsDir}/voice-chat.jar`, 'voice chat jar content');

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/servers/${serverId}/mods/voice-chat.jar`,
      cookies: { vr_session: adminCookie },
    });

    expect(delRes.statusCode).toBe(200);
    expect(fs.existsSync(`${modsDir}/voice-chat.jar`)).toBe(false);
  });

  it('POST /api/servers/:id/mods/upload uploads an external .jar file', async () => {
    const fakeJarBase64 = Buffer.from('PK\x03\x04fake-jar-data').toString('base64');

    const res = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/mods/upload`,
      cookies: { vr_session: adminCookie },
      payload: {
        filename: 'custom-mod.jar',
        contentBase64: fakeJarBase64,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().filename).toBe('custom-mod.jar');
    expect(res.json().sizeBytes).toBeGreaterThan(0);

    const modsDir = getModsDirectory(serverId, 'minecraft-java');
    expect(fs.existsSync(`${modsDir}/custom-mod.jar`)).toBe(true);
  });

  it('detectServerGameVersion extracts running version from .fabric-manifest.json', () => {
    const serverDir = getServerDataDir(serverId);
    fs.writeFileSync(
      `${serverDir}/.fabric-manifest.json`,
      JSON.stringify({ origin: { game: '26.3', loader: '0.20.1' } }),
    );

    const detected = detectServerGameVersion(serverId, 'minecraft-java');
    expect(detected).toBe('26.3');
  });

  describe('Modrinth .mrpack Modpack Support', () => {
    function createTestMrpack(manifest: Record<string, unknown>, extraFiles: Record<string, string> = {}): Buffer {
      const entries: Array<{ filename: string; content: Buffer }> = [
        {
          filename: 'modrinth.index.json',
          content: Buffer.from(JSON.stringify(manifest), 'utf8'),
        },
      ];

      for (const [fn, content] of Object.entries(extraFiles)) {
        entries.push({
          filename: fn,
          content: Buffer.from(content, 'utf8'),
        });
      }

      const localHeaders: Buffer[] = [];
      const cdHeaders: Buffer[] = [];
      let offset = 0;

      for (const entry of entries) {
        const fnBytes = Buffer.from(entry.filename, 'utf8');
        const data = entry.content;

        const lh = Buffer.alloc(30 + fnBytes.length + data.length);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0, 6);
        lh.writeUInt16LE(0, 8); // method 0 (uncompressed)
        lh.writeUInt16LE(0, 10);
        lh.writeUInt16LE(0, 12);
        lh.writeUInt32LE(0, 14);
        lh.writeUInt32LE(data.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(fnBytes.length, 26);
        lh.writeUInt16LE(0, 28);
        fnBytes.copy(lh, 30);
        data.copy(lh, 30 + fnBytes.length);
        localHeaders.push(lh);

        const cdh = Buffer.alloc(46 + fnBytes.length);
        cdh.writeUInt32LE(0x02014b50, 0);
        cdh.writeUInt16LE(20, 4);
        cdh.writeUInt16LE(20, 6);
        cdh.writeUInt16LE(0, 8);
        cdh.writeUInt16LE(0, 10);
        cdh.writeUInt16LE(0, 12);
        cdh.writeUInt32LE(0, 14);
        cdh.writeUInt32LE(0, 16);
        cdh.writeUInt32LE(data.length, 20);
        cdh.writeUInt32LE(data.length, 24);
        cdh.writeUInt16LE(fnBytes.length, 28);
        cdh.writeUInt16LE(0, 30);
        cdh.writeUInt16LE(0, 32);
        cdh.writeUInt16LE(0, 34);
        cdh.writeUInt16LE(0, 36);
        cdh.writeUInt32LE(0, 38);
        cdh.writeUInt32LE(offset, 42);
        fnBytes.copy(cdh, 46);
        cdHeaders.push(cdh);

        offset += lh.length;
      }

      const cdOffset = offset;
      const cdData = Buffer.concat(cdHeaders);
      const cdSize = cdData.length;

      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(entries.length, 8);
      eocd.writeUInt16LE(entries.length, 10);
      eocd.writeUInt32LE(cdSize, 12);
      eocd.writeUInt32LE(cdOffset, 16);
      eocd.writeUInt16LE(0, 20);

      return Buffer.concat([...localHeaders, cdData, eocd]);
    }

    it('POST /api/servers/:id/mods/upload installs .mrpack and extracts overrides', async () => {
      const manifest = {
        formatVersion: 1,
        game: 'minecraft',
        versionId: '1.0.0-fabric',
        name: 'Ultimate Fabric Pack',
        summary: 'A curated test modpack',
        files: [
          {
            path: 'mods/client-only-gui.jar',
            downloads: ['https://example.com/client-only.jar'],
            env: { client: 'required', server: 'unsupported' },
          },
        ],
        dependencies: {
          minecraft: '1.21.4',
          'fabric-loader': '>=0.16.0',
        },
      };

      const extraFiles = {
        'overrides/config/gameplay.json': '{"difficulty":"hard"}',
        'server-overrides/config/server-tuning.json': '{"viewDistance":12}',
      };

      const mrpackBuffer = createTestMrpack(manifest, extraFiles);
      const b64 = mrpackBuffer.toString('base64');

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/mods/upload`,
        cookies: { vr_session: adminCookie },
        payload: {
          filename: 'ultimate-pack.mrpack',
          contentBase64: b64,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.isMrpack).toBe(true);
      expect(body.modpackName).toBe('Ultimate Fabric Pack');
      expect(body.versionId).toBe('1.0.0-fabric');
      expect(body.installedFilesCount).toBe(2);
      expect(body.skippedClientModsCount).toBe(1);

      // Verify files were extracted to the server data volume directory
      const serverDir = getServerDataDir(serverId);
      expect(fs.existsSync(`${serverDir}/config/gameplay.json`)).toBe(true);
      expect(fs.readFileSync(`${serverDir}/config/gameplay.json`, 'utf8')).toBe('{"difficulty":"hard"}');
      expect(fs.existsSync(`${serverDir}/config/server-tuning.json`)).toBe(true);
      expect(fs.readFileSync(`${serverDir}/config/server-tuning.json`, 'utf8')).toBe('{"viewDistance":12}');

      // Verify .vaultrealm-modpack.json was saved
      expect(fs.existsSync(`${serverDir}/.vaultrealm-modpack.json`)).toBe(true);

      // Verify GET /api/servers/:id/mods now includes modpack metadata
      const modsRes = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/mods`,
        cookies: { vr_session: adminCookie },
      });

      expect(modsRes.statusCode).toBe(200);
      const modsBody = modsRes.json();
      expect(modsBody.modpack).toBeDefined();
      expect(modsBody.modpack.name).toBe('Ultimate Fabric Pack');
      expect(modsBody.modpack.versionId).toBe('1.0.0-fabric');
      expect(modsBody.modpack.installedFilesCount).toBe(2);
    });

    it('rejects unsupported game in .mrpack archive', async () => {
      const manifest = {
        formatVersion: 1,
        game: 'terraria',
        name: 'Terraria Pack',
        files: [],
      };

      const mrpackBuffer = createTestMrpack(manifest);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/mods/upload`,
        cookies: { vr_session: adminCookie },
        payload: {
          filename: 'terraria.mrpack',
          contentBase64: mrpackBuffer.toString('base64'),
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('UNSUPPORTED_GAME');
      expect(res.json().message).toContain('Only Minecraft modpacks are supported');
    });

    it('rejects corrupted .mrpack archive missing manifest', async () => {
      const corruptedBuffer = Buffer.from('PK\x03\x04corrupted-archive-without-manifest');
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/mods/upload`,
        cookies: { vr_session: adminCookie },
        payload: {
          filename: 'bad.mrpack',
          contentBase64: corruptedBuffer.toString('base64'),
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_MRPACK');
    });
  });
});
