import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  cleanupTestApp,
  registerAdmin,
  registerUser,
  createInvite,
} from './helpers.js';
import { getServerDataDir } from '../src/servers/volume.js';
import {
  getDockerImageFolderName,
  getOrCreateDriveSubfolder,
  clearDriveFolderCache,
  uploadToGoogleDrive,
  saveDriveConfig,
} from '../src/backups/gdrive.js';

describe('Server Backups & Google Drive Integration', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let serverId: string;

  beforeEach(async () => {
    app = await buildTestApp();
    const { cookies } = await registerAdmin(app);
    adminCookie = cookies['vr_session']!;

    // Create a game server
    const serverRes = await app.inject({
      method: 'POST',
      url: '/api/servers',
      cookies: { vr_session: adminCookie },
      payload: { name: 'Backup Test Server', templateId: 'minecraft-java' },
    });
    serverId = serverRes.json().id;

    // Create mock files in the server volume
    const serverDir = getServerDataDir(serverId);
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'server.properties'), 'motd=TestServer\nonline-mode=false\n');
    fs.mkdirSync(path.join(serverDir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'MOCK_LEVEL_DATA_BYTES');
  });

  afterEach(() => {
    cleanupTestApp();
    vi.restoreAllMocks();
  });

  describe('Server Backups Lifecycle', () => {
    it('creates a local server backup successfully', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/backups`,
        cookies: { vr_session: adminCookie },
        payload: { name: 'Initial World Save' },
      });

      expect(res.statusCode).toBe(201);
      const data = res.json();
      expect(data.id).toBeDefined();
      expect(data.serverId).toBe(serverId);
      expect(data.name).toBe('Initial World Save');
      expect(data.sizeBytes).toBeGreaterThan(0);
      expect(data.localExists).toBe(true);
      expect(fs.existsSync(data.path)).toBe(true);
    });

    it('lists server backups', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/backups`,
        cookies: { vr_session: adminCookie },
        payload: { name: 'Snapshot 1' },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/backups`,
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.backups).toBeInstanceOf(Array);
      expect(data.backups.length).toBe(1);
      expect(data.backups[0].name).toBe('Snapshot 1');
      expect(data.backups[0].localExists).toBe(true);
    });

    it('downloads a server backup archive', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/backups`,
        cookies: { vr_session: adminCookie },
      });
      const backupId = createRes.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/backups/${backupId}/download`,
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/gzip');
      expect(res.headers['content-disposition']).toContain('attachment; filename=');
      expect(res.rawPayload.length).toBeGreaterThan(0);
    });

    it('restores a server from backup snapshot', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/backups`,
        cookies: { vr_session: adminCookie },
      });
      const backupId = createRes.json().id;

      // Simulate modification / deletion of world file
      const serverDir = getServerDataDir(serverId);
      const levelDatPath = path.join(serverDir, 'world', 'level.dat');
      fs.writeFileSync(levelDatPath, 'CORRUPTED_OR_CHANGED_DATA');

      // Restore backup
      const restoreRes = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/backups/${backupId}/restore`,
        cookies: { vr_session: adminCookie },
      });

      expect(restoreRes.statusCode).toBe(200);
      expect(restoreRes.json().message).toContain('restored');

      // Verify original file was restored
      const restoredContent = fs.readFileSync(levelDatPath, 'utf8');
      expect(restoredContent).toBe('MOCK_LEVEL_DATA_BYTES');
    });

    it('deletes a server backup', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/backups`,
        cookies: { vr_session: adminCookie },
      });
      const backup = createRes.json();
      expect(fs.existsSync(backup.path)).toBe(true);

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}/backups/${backup.id}`,
        cookies: { vr_session: adminCookie },
      });

      expect(delRes.statusCode).toBe(200);
      expect(fs.existsSync(backup.path)).toBe(false);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/backups`,
        cookies: { vr_session: adminCookie },
      });
      expect(listRes.json().backups).toHaveLength(0);
    });

    it('enforces RBAC permissions on backup endpoints', async () => {
      const inviteRes = await createInvite(app, adminCookie);
      const { cookies: userCookies } = await registerUser(app, inviteRes.json().code);

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/backups`,
        cookies: { vr_session: userCookies['vr_session']! },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('Google Drive OAuth & Configuration', () => {
    it('returns configured: false when not set up', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/system/google-drive',
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().configured).toBe(false);
    });

    it('saves and masks Google Drive OAuth config with mocked token test', async () => {
      // Mock global fetch for Google Drive OAuth verification
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockImplementation((url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.includes('oauth2.googleapis.com/token')) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'mock_access_token_123', expires_in: 3600 }), {
              status: 200,
            }),
          );
        }
        if (urlStr.includes('googleapis.com/drive/v3/about')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                user: { displayName: 'VaultRealm Admin', emailAddress: 'admin@vaultrealm.io' },
                storageQuota: { limit: '107374182400', usage: '53687091200' },
              }),
              { status: 200 },
            ),
          );
        }
        return originalFetch(url);
      });

      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/system/google-drive',
        cookies: { vr_session: adminCookie },
        payload: {
          clientId: '123456789-abcdef.apps.googleusercontent.com',
          clientSecret: 'GOCSPX-secret123456',
          refreshToken: '1//04mock_refresh_token_xyz',
        },
      });

      expect(putRes.statusCode).toBe(200);
      const data = putRes.json();
      expect(data.config.configured).toBe(true);
      expect(data.config.userEmail).toBe('admin@vaultrealm.io');
      expect(data.config.clientId).toContain('***');

      // Test endpoint
      const testRes = await app.inject({
        method: 'POST',
        url: '/api/system/google-drive/test',
        cookies: { vr_session: adminCookie },
      });
      expect(testRes.statusCode).toBe(200);
      expect(testRes.json().details.displayName).toBe('VaultRealm Admin');
    });

    it('detects CLIENT_ID and CLIENT_SECRET from environment aliases', async () => {
      const origClientId = process.env.CLIENT_ID;
      const origClientSecret = process.env.CLIENT_SECRET;
      try {
        process.env.CLIENT_ID = '772379419361-env-alias.apps.googleusercontent.com';
        process.env.CLIENT_SECRET = 'GOCSPX-secretalias';

        const configRes = await app.inject({
          method: 'GET',
          url: '/api/system/google-drive',
          cookies: { vr_session: adminCookie },
        });

        expect(configRes.statusCode).toBe(200);
        const configData = configRes.json();
        expect(configData.hasEnvCredentials).toBe(true);
        expect(configData.clientId).toBe('772379419361-env-alias.apps.googleusercontent.com');
      } finally {
        if (origClientId !== undefined) process.env.CLIENT_ID = origClientId;
        else delete process.env.CLIENT_ID;
        if (origClientSecret !== undefined) process.env.CLIENT_SECRET = origClientSecret;
        else delete process.env.CLIENT_SECRET;
      }
    });

    it('generates Google OAuth authorization URL for 1-click Sign-in', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/system/google-drive/auth-url?clientId=custom-client-id.apps.googleusercontent.com',
        cookies: { vr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.url).toContain('accounts.google.com/o/oauth2/v2/auth');
      expect(data.url).toContain('custom-client-id.apps.googleusercontent.com');
      expect(data.redirectUri).toBeDefined();
    });

    it('saves OAuth app credentials and generates auth URL via POST', async () => {
      const credsRes = await app.inject({
        method: 'POST',
        url: '/api/system/google-drive/credentials',
        cookies: { vr_session: adminCookie },
        payload: {
          clientId: '772379419361-posttest.apps.googleusercontent.com',
          clientSecret: 'GOCSPX-secretposttest',
        },
      });

      expect(credsRes.statusCode).toBe(200);
      expect(credsRes.json().config.hasClientCredentials).toBe(true);

      const postAuthRes = await app.inject({
        method: 'POST',
        url: '/api/system/google-drive/auth-url',
        cookies: { vr_session: adminCookie },
        payload: {
          redirectUri: 'https://realm.vaultsoftlabs.tech/api/system/google-drive/callback',
        },
      });

      expect(postAuthRes.statusCode).toBe(200);
      const authData = postAuthRes.json();
      expect(authData.url).toContain('772379419361-posttest.apps.googleusercontent.com');
      expect(authData.url).toContain('redirect_uri=https%3A%2F%2Frealm.vaultsoftlabs.tech%2Fapi%2Fsystem%2Fgoogle-drive%2Fcallback');
    });

    it('connects via Shared Folder Webhook (Google Apps Script)', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockImplementation((url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.includes('script.google.com')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ ok: true, folderName: 'Minecraft Community Backups', folderId: 'folder_123' }),
              { status: 200 },
            ),
          );
        }
        return originalFetch(url);
      });

      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/system/google-drive',
        cookies: { vr_session: adminCookie },
        payload: {
          mode: 'webhook',
          webhookUrl: 'https://script.google.com/macros/s/AKfycb_mock_app_script_test/exec',
          folderId: 'folder_123',
        },
      });

      expect(putRes.statusCode).toBe(200);
      const data = putRes.json();
      expect(data.config.configured).toBe(true);
      expect(data.config.mode).toBe('webhook');
      expect(data.config.folderName).toBe('Minecraft Community Backups');
    });
  });

  describe('Full System Disaster Recovery Backup', () => {
    it('creates a full panel system backup', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/system/backups',
        cookies: { vr_session: adminCookie },
        payload: { uploadToDrive: false },
      });

      expect(res.statusCode).toBe(201);
      const data = res.json();
      expect(data.id).toBeDefined();
      expect(data.filename).toContain('vaultrealm_full_system_');
      expect(data.sizeBytes).toBeGreaterThan(0);
      expect(fs.existsSync(data.path)).toBe(true);

      // List system backups
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/system/backups',
        cookies: { vr_session: adminCookie },
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().backups.length).toBeGreaterThan(0);
    });
  });

  describe('Docker Image-Related Google Drive Subfolder Organization', () => {
    beforeEach(() => {
      clearDriveFolderCache();
    });

    it('formats various Docker image names into clean folder names', () => {
      expect(getDockerImageFolderName('itzg/minecraft-server:latest')).toBe('itzg-minecraft-server');
      expect(getDockerImageFolderName('itzg/minecraft-server')).toBe('itzg-minecraft-server');
      expect(getDockerImageFolderName('thijsvanloef/palworld-server-docker:latest')).toBe(
        'thijsvanloef-palworld-server-docker',
      );
      expect(getDockerImageFolderName('ryshe/terraria:latest')).toBe('ryshe-terraria');
      expect(getDockerImageFolderName('ghcr.io/vaultrealm/bot-runner:edge')).toBe('vaultrealm-bot-runner');
      expect(getDockerImageFolderName('docker.io/itzg/minecraft-server:1.20')).toBe('itzg-minecraft-server');
      expect(getDockerImageFolderName('minecraft-java')).toBe('minecraft-java');
      expect(getDockerImageFolderName('vaultrealm-system')).toBe('vaultrealm-system');
    });

    it('looks up existing folder and creates new folder on Drive when missing', async () => {
      const originalFetch = global.fetch;
      let searchedQuery = '';
      let createdBody: Record<string, unknown> | null = null;

      global.fetch = vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);

        if (urlStr.includes('/files?') && init?.method !== 'POST') {
          searchedQuery = decodeURIComponent(urlStr);
          // Return not found first time
          return Promise.resolve(
            new Response(JSON.stringify({ files: [] }), { status: 200 }),
          );
        }

        if (urlStr.includes('/files') && init?.method === 'POST') {
          createdBody = JSON.parse(String(init.body));
          return Promise.resolve(
            new Response(JSON.stringify({ id: 'created_folder_id_789', name: createdBody?.name }), {
              status: 200,
            }),
          );
        }

        return originalFetch(url, init);
      });

      const folderId = await getOrCreateDriveSubfolder('mock_access_token', 'itzg-minecraft-server', 'base_parent_123');

      expect(searchedQuery).toContain("name = 'itzg-minecraft-server'");
      expect(searchedQuery).toContain("'base_parent_123' in parents");
      expect(createdBody).not.toBeNull();
      expect(createdBody?.name).toBe('itzg-minecraft-server');
      expect(createdBody?.parents).toEqual(['base_parent_123']);
      expect(folderId).toBe('created_folder_id_789');

      // Second call should return cached ID without invoking fetch again
      const callCountBefore = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      const cachedFolderId = await getOrCreateDriveSubfolder('mock_access_token', 'itzg-minecraft-server', 'base_parent_123');
      expect(cachedFolderId).toBe('created_folder_id_789');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBefore);
    });

    it('uploads backup archive into the image-related subfolder (OAuth mode)', async () => {
      const originalFetch = global.fetch;
      let capturedParents: string[] | undefined;

      global.fetch = vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);

        if (urlStr.includes('oauth2.googleapis.com/token')) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'mock_token_abc', expires_in: 3600 }), { status: 200 }),
          );
        }

        if (urlStr.includes('/about')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                user: { displayName: 'VaultRealm Tester', emailAddress: 'tester@vaultrealm.io' },
              }),
              { status: 200 },
            ),
          );
        }

        // Search for subfolder -> return existing subfolder
        if (urlStr.includes('/files?') && init?.method !== 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                files: [{ id: 'subfolder_itzg_minecraft', name: 'itzg-minecraft-server' }],
              }),
              { status: 200 },
            ),
          );
        }

        // Upload endpoint
        if (urlStr.includes('/upload/drive/v3/files')) {
          const bodyStr = String(init?.body || '');
          const match = bodyStr.match(/"parents":(\[[^\]]+\])/);
          if (match && match[1]) {
            capturedParents = JSON.parse(match[1]);
          }
          return Promise.resolve(
            new Response(JSON.stringify({ id: 'uploaded_file_id_999', name: 'backup.tar.gz' }), { status: 200 }),
          );
        }

        return originalFetch(url, init);
      });

      // Save OAuth configuration
      await saveDriveConfig({
        mode: 'oauth',
        clientId: 'test-client-id.apps.googleusercontent.com',
        clientSecret: 'secret_123',
        refreshToken: 'refresh_123',
        folderId: 'base_vaultrealm_root',
      });

      // Create a temporary backup file
      const tempPath = path.join(getServerDataDir(serverId), 'test_backup.tar.gz');
      fs.writeFileSync(tempPath, 'MOCK_ARCHIVE_DATA');

      const result = await uploadToGoogleDrive({
        filename: 'test_backup.tar.gz',
        filePath: tempPath,
        image: 'itzg/minecraft-server:latest',
      });

      expect(result.fileId).toBe('uploaded_file_id_999');
      expect(capturedParents).toEqual(['subfolder_itzg_minecraft']);
    });

    it('passes subfolderName to Google Apps Script webhook mode', async () => {
      const originalFetch = global.fetch;
      let webhookPayload: Record<string, unknown> | null = null;

      global.fetch = vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes('script.google.com')) {
          webhookPayload = JSON.parse(String(init?.body));
          return Promise.resolve(
            new Response(
              JSON.stringify({ ok: true, fileId: 'webhook_file_123', folderName: 'Community' }),
              { status: 200 },
            ),
          );
        }
        return originalFetch(url, init);
      });

      await saveDriveConfig({
        mode: 'webhook',
        webhookUrl: 'https://script.google.com/macros/s/AKfycb_webhook_test/exec',
        folderId: 'base_webhook_folder',
      });

      const tempPath = path.join(getServerDataDir(serverId), 'webhook_backup.tar.gz');
      fs.writeFileSync(tempPath, 'MOCK_WEBHOOK_BYTES');

      const result = await uploadToGoogleDrive({
        filename: 'webhook_backup.tar.gz',
        filePath: tempPath,
        image: 'thijsvanloef/palworld-server-docker:latest',
      });

      expect(result.fileId).toBe('webhook_file_123');
      expect(webhookPayload).not.toBeNull();
      expect(webhookPayload?.subfolderName).toBe('thijsvanloef-palworld-server-docker');
      expect(webhookPayload?.folderId).toBe('base_webhook_folder');
    });

    it('on-demand upload route (uploadBackupToDrive) uses server Docker image', async () => {
      const originalFetch = global.fetch;
      let targetParents: string[] | undefined;

      global.fetch = vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);

        if (urlStr.includes('oauth2.googleapis.com/token')) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'mock_token_abc', expires_in: 3600 }), { status: 200 }),
          );
        }

        if (urlStr.includes('/about')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                user: { displayName: 'VaultRealm Admin', emailAddress: 'admin@vaultrealm.io' },
              }),
              { status: 200 },
            ),
          );
        }

        // Folder search
        if (urlStr.includes('/files?') && init?.method !== 'POST') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                files: [{ id: 'subfolder_minecraft_java', name: 'itzg-minecraft-server' }],
              }),
              { status: 200 },
            ),
          );
        }

        if (urlStr.includes('/upload/drive/v3/files')) {
          const bodyStr = String(init?.body || '');
          const match = bodyStr.match(/"parents":(\[[^\]]+\])/);
          if (match && match[1]) {
            targetParents = JSON.parse(match[1]);
          }
          return Promise.resolve(
            new Response(JSON.stringify({ id: 'file_backed_up_123', webViewLink: 'https://drive.google.com/file' }), {
              status: 200,
            }),
          );
        }

        return originalFetch(url, init);
      });

      await saveDriveConfig({
        mode: 'oauth',
        clientId: 'client-id-test.apps.googleusercontent.com',
        clientSecret: 'secret_abc',
        refreshToken: 'refresh_abc',
      });

      // Create backup
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/backups`,
        cookies: { vr_session: adminCookie },
      });
      const backupId = createRes.json().id;

      // Call on-demand drive upload
      const uploadRes = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/backups/${backupId}/upload-drive`,
        cookies: { vr_session: adminCookie },
      });

      expect(uploadRes.statusCode).toBe(200);
      expect(uploadRes.json().gdriveSynced).toBe(true);
      expect(uploadRes.json().gdriveFileId).toBe('file_backed_up_123');
      expect(targetParents).toEqual(['subfolder_minecraft_java']);
    });
  });
});

