/**
 * Google Drive integration for VaultRealm backups & disaster recovery.
 *
 * Supports two seamless connection methods:
 * 1. "Sign in with Google" (OAuth2 Web flow with automated authorization code exchange)
 * 2. "Shared Folder Webhook" (Google Apps Script Web App for zero-Google-Cloud setup)
 *
 * Plus manual OAuth credentials for advanced power users.
 * All credentials encrypted with AES-256-GCM at rest.
 */

import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../db/index.js';
import { systemSettings } from '../db/schema.js';
import { encryptApiKey, decryptApiKey } from '../companion/crypto.js';

const SETTINGS_KEY = 'google_drive_oauth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';

export interface GoogleDriveConfigInput {
  mode?: 'oauth' | 'webhook';
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  folderId?: string;
  webhookUrl?: string;
  accessToken?: string;
  expiresIn?: number;
}

export interface StoredGoogleDriveConfig {
  mode?: 'oauth' | 'webhook';
  clientId?: string;
  clientSecretEnc?: string;
  refreshTokenEnc?: string;
  folderId?: string;
  folderName?: string;
  userEmail?: string;
  userName?: string;
  webhookUrl?: string;
  updatedAt?: string;
}

export interface PublicGoogleDriveConfig {
  configured: boolean;
  mode?: 'oauth' | 'webhook';
  clientId?: string;
  folderId?: string;
  folderName?: string;
  userEmail?: string;
  userName?: string;
  displayName?: string;
  webhookUrl?: string;
  hasEnvCredentials?: boolean;
  hasClientCredentials?: boolean;
  envClientId?: string;
}

export interface GoogleDriveTestResult {
  ok: boolean;
  email?: string;
  displayName?: string;
  storageQuota?: {
    limitBytes: number;
    usageBytes: number;
  };
  folderName?: string;
  error?: string;
}

// In-memory token cache for OAuth mode
let _cachedAccessToken: string | null = null;
let _tokenExpiresAt = 0;

/**
 * Retrieve raw stored Google Drive configuration from database.
 */
function getEnvClientId(): string | undefined {
  const id = process.env.GOOGLE_CLIENT_ID || process.env.CLIENT_ID;
  return id?.trim() || undefined;
}

function getEnvClientSecret(): string | undefined {
  const secret = process.env.GOOGLE_CLIENT_SECRET || process.env.CLIENT_SECRET;
  return secret?.trim() || undefined;
}
export function getStoredDriveConfig(): StoredGoogleDriveConfig | null {
  const db = getDatabase();
  const row = db.select().from(systemSettings).where(eq(systemSettings.key, SETTINGS_KEY)).all()[0];
  if (!row) return null;

  try {
    return JSON.parse(row.valueJson) as StoredGoogleDriveConfig;
  } catch {
    return null;
  }
}

/**
 * Get sanitized/public Google Drive configuration for UI display.
 */
/**
 * Save Google OAuth 2.0 app credentials (Client ID, Client Secret, optional folder ID) to settings.
 */
export function saveOAuthAppCredentials(input: {
  clientId: string;
  clientSecret?: string;
  folderId?: string;
}): StoredGoogleDriveConfig {
  const existing = getStoredDriveConfig() || { updatedAt: new Date().toISOString() };
  const clientSecretEnc = input.clientSecret?.trim()
    ? encryptApiKey(input.clientSecret.trim())
    : existing.clientSecretEnc;

  const updated: StoredGoogleDriveConfig = {
    ...existing,
    mode: 'oauth',
    clientId: input.clientId.trim(),
    clientSecretEnc,
    folderId: input.folderId?.trim() || existing.folderId,
    updatedAt: new Date().toISOString(),
  };

  const db = getDatabase();
  const json = JSON.stringify(updated);
  const row = db.select().from(systemSettings).where(eq(systemSettings.key, SETTINGS_KEY)).all()[0];
  if (row) {
    db.update(systemSettings).set({ valueJson: json }).where(eq(systemSettings.key, SETTINGS_KEY)).run();
  } else {
    db.insert(systemSettings).values({ key: SETTINGS_KEY, valueJson: json }).run();
  }

  return updated;
}

export function getPublicDriveConfig(): PublicGoogleDriveConfig {
  const stored = getStoredDriveConfig();
  const envClientId = getEnvClientId();
  const envClientSecret = getEnvClientSecret();
  const hasEnvCredentials = Boolean(envClientId && envClientSecret);
  const hasClientCredentials = Boolean(
    hasEnvCredentials || (stored?.clientId && (stored.clientSecretEnc || envClientSecret)),
  );

  if (!stored) {
    return {
      configured: false,
      hasEnvCredentials,
      hasClientCredentials,
      clientId: envClientId,
      envClientId: envClientId ? `${envClientId.slice(0, 4)}***` : undefined,
    };
  }

  if (stored.mode === 'webhook') {
    return {
      configured: true,
      mode: 'webhook',
      webhookUrl: stored.webhookUrl ? `${stored.webhookUrl.slice(0, 32)}...` : undefined,
      folderId: stored.folderId,
      folderName: stored.folderName || 'Google Drive Shared Folder',
      displayName: 'Shared Folder Webhook',
      hasEnvCredentials,
      hasClientCredentials,
    };
  }

  // OAuth mode: if refreshTokenEnc is missing, OAuth app credentials are saved but account not signed in yet
  const hasRefreshToken = Boolean(stored.refreshTokenEnc);
  const rawId = stored.clientId || envClientId || '';
  const parts = rawId.split('-');
  const firstPart = parts[0] ?? '';
  const maskedClientId = parts.length > 1 ? `${firstPart.slice(0, 4)}***-${parts.slice(1).join('-')}` : rawId;

  if (!hasRefreshToken) {
    return {
      configured: false,
      mode: 'oauth',
      clientId: stored.clientId || envClientId,
      folderId: stored.folderId,
      hasEnvCredentials,
      hasClientCredentials,
    };
  }

  return {
    configured: true,
    mode: 'oauth',
    clientId: maskedClientId,
    folderId: stored.folderId,
    folderName: stored.folderName,
    userEmail: stored.userEmail,
    userName: stored.userName,
    displayName: stored.userName || stored.userEmail,
    hasEnvCredentials,
    hasClientCredentials,
  };
}

/**
 * Generate Google OAuth2 authorization URL for 1-click Sign in with Google.
 * If clientId / clientSecret are provided, persists them to settings so the callback can exchange tokens.
 */
export function getGoogleDriveAuthUrl(opts: {
  clientId?: string;
  clientSecret?: string;
  folderId?: string;
  redirectUri: string;
  state?: string;
}): string {
  // If client credentials are provided, save them to settings immediately
  if (opts.clientId?.trim()) {
    saveOAuthAppCredentials({
      clientId: opts.clientId.trim(),
      clientSecret: opts.clientSecret?.trim(),
      folderId: opts.folderId?.trim(),
    });
  }

  const stored = getStoredDriveConfig();
  const envClientId = getEnvClientId();
  const clientId = opts.clientId?.trim() || stored?.clientId || envClientId;
  if (!clientId) {
    throw new Error('Google Client ID is required. Enter your Client ID or set GOOGLE_CLIENT_ID / CLIENT_ID in server environment.');
  }

  // Preserve redirectUri in state parameter to prevent any redirect URI mismatch behind proxies
  let stateParam = opts.state;
  if (!stateParam) {
    try {
      stateParam = Buffer.from(JSON.stringify({ redirectUri: opts.redirectUri })).toString('base64url');
    } catch {
      stateParam = undefined;
    }
  }

  const params = new URLSearchParams({
    client_id: clientId.trim(),
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline',
    prompt: 'consent',
  });

  if (stateParam) {
    params.set('state', stateParam);
  }

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange an OAuth authorization code for tokens and save configuration.
 */
export async function exchangeAuthCode(opts: {
  code: string;
  redirectUri: string;
  clientId?: string;
  clientSecret?: string;
  folderId?: string;
}): Promise<PublicGoogleDriveConfig> {
  const stored = getStoredDriveConfig();
  const envClientId = getEnvClientId();
  const envClientSecret = getEnvClientSecret();
  const clientId = opts.clientId?.trim() || stored?.clientId || envClientId;
  const clientSecret =
    opts.clientSecret?.trim() ||
    (stored?.clientSecretEnc ? decryptApiKey(stored.clientSecretEnc) : envClientSecret);

  if (!clientId || !clientSecret) {
    throw new Error(
      'Both Google Client ID and Client Secret are required for OAuth authorization code exchange. Please enter both under "OAuth App Credentials" in VaultRealm.',
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: opts.code.trim(),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    let errMsg = errText;
    try {
      const errJson = JSON.parse(errText) as { error?: string; error_description?: string };
      errMsg = errJson.error_description || errJson.error || errText;
    } catch {
      // Keep raw response text
    }
    throw new Error(`Google token exchange failed (${res.status}): ${errMsg}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  const refreshToken = data.refresh_token || (stored?.refreshTokenEnc ? decryptApiKey(stored.refreshTokenEnc) : null);
  if (!refreshToken) {
    throw new Error('Google did not return a refresh token. Please re-authenticate with prompt=consent.');
  }

  return await saveDriveConfig({
    mode: 'oauth',
    clientId,
    clientSecret,
    refreshToken,
    folderId: opts.folderId || stored?.folderId,
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  });
}

/**
 * Save or update Google Drive credentials (either OAuth or Shared Folder Webhook).
 */
export async function saveDriveConfig(input: GoogleDriveConfigInput): Promise<PublicGoogleDriveConfig> {
  const existing = getStoredDriveConfig();
  const mode = input.mode || (input.webhookUrl ? 'webhook' : 'oauth');

  if (mode === 'webhook') {
    if (!input.webhookUrl?.trim()) {
      throw new Error('Webhook URL is required for Shared Folder Webhook mode.');
    }

    const test = await testWebhookConnection(input.webhookUrl.trim(), input.folderId?.trim());
    if (!test.ok) {
      throw new Error(`Shared Folder Webhook test failed: ${test.error}`);
    }

    const stored: StoredGoogleDriveConfig = {
      mode: 'webhook',
      webhookUrl: input.webhookUrl.trim(),
      folderId: input.folderId?.trim() || undefined,
      folderName: test.folderName || 'Google Drive Shared Folder',
      updatedAt: new Date().toISOString(),
    };

    saveStoredConfig(stored);
    return getPublicDriveConfig();
  }

  // OAuth Mode
  const envClientId = getEnvClientId();
  const envClientSecret = getEnvClientSecret();
  const clientId = input.clientId?.trim() || existing?.clientId || envClientId || '';
  const clientSecret = input.clientSecret ? input.clientSecret.trim() : null;
  const refreshToken = input.refreshToken ? input.refreshToken.trim() : null;

  const clientSecretEnc = clientSecret
    ? encryptApiKey(clientSecret)
    : existing?.clientSecretEnc || (envClientSecret ? encryptApiKey(envClientSecret) : undefined);
  const refreshTokenEnc = refreshToken
    ? encryptApiKey(refreshToken)
    : existing?.refreshTokenEnc;

  if (!clientId) {
    throw new Error('Google Client ID is required.');
  }
  if (!clientSecretEnc || !refreshTokenEnc) {
    throw new Error('Both clientSecret and refreshToken are required to configure Google Drive OAuth.');
  }

  const stored: StoredGoogleDriveConfig = {
    mode: 'oauth',
    clientId,
    clientSecretEnc,
    refreshTokenEnc,
    folderId: input.folderId?.trim() || existing?.folderId || undefined,
    userEmail: existing?.userEmail,
    userName: existing?.userName,
    folderName: existing?.folderName,
    updatedAt: new Date().toISOString(),
  };

  if (input.accessToken) {
    _cachedAccessToken = input.accessToken;
    _tokenExpiresAt = Date.now() + (input.expiresIn || 3600) * 1000;
  } else {
    // Clear in-memory token cache on credential update if no fresh token provided
    _cachedAccessToken = null;
    _tokenExpiresAt = 0;
  }

  // Save credentials first so that the user's authorization is preserved
  saveStoredConfig(stored);

  // Verify connection immediately and store account info
  const test = await testGoogleDriveConnection(stored);
  if (!test.ok) {
    throw new Error(`Google Drive verification failed: ${test.error}`);
  }

  stored.userEmail = test.email;
  stored.userName = test.displayName;
  stored.folderName = test.folderName;

  saveStoredConfig(stored);
  return getPublicDriveConfig();
}

function saveStoredConfig(stored: StoredGoogleDriveConfig): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.insert(systemSettings)
    .values({
      key: SETTINGS_KEY,
      valueJson: JSON.stringify(stored),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        valueJson: JSON.stringify(stored),
        updatedAt: now,
      },
    })
    .run();
}

/**
 * Delete stored Google Drive credentials.
 */
export function deleteDriveConfig(): void {
  const db = getDatabase();
  db.delete(systemSettings).where(eq(systemSettings.key, SETTINGS_KEY)).run();
  _cachedAccessToken = null;
  _tokenExpiresAt = 0;
}

/**
 * Fetch a fresh OAuth2 access token using the stored refresh token.
 */
export async function getValidAccessToken(providedConfig?: StoredGoogleDriveConfig): Promise<string> {
  const now = Date.now();
  if (_cachedAccessToken && now < _tokenExpiresAt - 60_000) {
    return _cachedAccessToken;
  }

  const config = providedConfig || getStoredDriveConfig();
  if (!config) {
    throw new Error('Google Drive is not configured.');
  }

  const envClientId = getEnvClientId();
  const envClientSecret = getEnvClientSecret();
  const clientId = config.clientId || envClientId;
  const clientSecret = config.clientSecretEnc
    ? decryptApiKey(config.clientSecretEnc)
    : envClientSecret;
  const refreshToken = config.refreshTokenEnc
    ? decryptApiKey(config.refreshTokenEnc)
    : undefined;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Drive credentials are incomplete or missing.');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  _cachedAccessToken = data.access_token;
  _tokenExpiresAt = now + data.expires_in * 1000;

  return _cachedAccessToken;
}

/**
 * Test Webhook endpoint connection (Google Apps Script).
 */
export async function testWebhookConnection(webhookUrl: string, folderId?: string): Promise<GoogleDriveTestResult> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ping', folderId }),
      redirect: 'follow',
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Webhook returned status ${res.status}: ${text.slice(0, 150)}` };
    }

    const data = (await res.json()) as { ok: boolean; folderName?: string; folderId?: string; error?: string };
    if (!data.ok) {
      return { ok: false, error: data.error || 'Webhook ping failed.' };
    }

    return {
      ok: true,
      folderName: data.folderName || 'Google Drive Shared Folder',
      displayName: 'Google Drive Shared Folder',
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Test Google Drive connection and inspect quota & user info.
 */
export async function testGoogleDriveConnection(
  providedConfig?: StoredGoogleDriveConfig,
): Promise<GoogleDriveTestResult> {
  const config = providedConfig || getStoredDriveConfig();
  if (!config) {
    return { ok: false, error: 'Google Drive is not configured.' };
  }

  if (config.mode === 'webhook' && config.webhookUrl) {
    return testWebhookConnection(config.webhookUrl, config.folderId);
  }

  try {
    const accessToken = await getValidAccessToken(config);

    // Call about endpoint for user and storage quota
    const res = await fetch(`${DRIVE_API_URL}/about?fields=user,storageQuota`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      let formattedError = `Drive API returned ${res.status}: ${errText}`;
      if (
        res.status === 403 &&
        (errText.includes('Google Drive API has not been used') || errText.includes('disabled'))
      ) {
        formattedError =
          'Google Drive API is disabled in your Google Cloud Project. Please enable "Google Drive API" at: https://console.cloud.google.com/apis/library/drive.googleapis.com';
      }
      return { ok: false, error: formattedError };
    }

    const data = (await res.json()) as {
      user?: { displayName: string; emailAddress: string };
      storageQuota?: { limit?: string; usage?: string };
    };

    let folderName: string | undefined;
    if (config.folderId) {
      try {
        const folderRes = await fetch(`${DRIVE_API_URL}/files/${encodeURIComponent(config.folderId)}?fields=name`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (folderRes.ok) {
          const folderData = (await folderRes.json()) as { name: string };
          folderName = folderData.name;
        }
      } catch {
        // ignore folder name error
      }
    }

    return {
      ok: true,
      email: data.user?.emailAddress,
      displayName: data.user?.displayName,
      folderName,
      storageQuota: data.storageQuota
        ? {
            limitBytes: Number(data.storageQuota.limit || 0),
            usageBytes: Number(data.storageQuota.usage || 0),
          }
        : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Upload a file to Google Drive using multipart upload (OAuth) or Webhook.
 */
export async function uploadToGoogleDrive(opts: {
  filename: string;
  filePath: string;
  description?: string;
}): Promise<{ fileId: string; webViewLink?: string }> {
  const config = getStoredDriveConfig();
  if (!config) {
    throw new Error('Google Drive is not configured.');
  }

  // Webhook mode
  if (config.mode === 'webhook' && config.webhookUrl) {
    const fileData = await fs.promises.readFile(opts.filePath);
    const contentBase64 = fileData.toString('base64');

    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'upload',
        filename: opts.filename,
        description: opts.description || 'VaultRealm Server Backup',
        folderId: config.folderId,
        contentBase64,
      }),
      redirect: 'follow',
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Shared Folder Webhook upload failed (${res.status}): ${errText}`);
    }

    const result = (await res.json()) as {
      ok: boolean;
      fileId?: string;
      webViewLink?: string;
      error?: string;
    };

    if (!result.ok || !result.fileId) {
      throw new Error(result.error || 'Shared Folder Webhook failed to save file.');
    }

    return {
      fileId: result.fileId,
      webViewLink: result.webViewLink,
    };
  }

  // OAuth mode
  const accessToken = await getValidAccessToken();
  const fileData = await fs.promises.readFile(opts.filePath);

  const metadata: Record<string, unknown> = {
    name: opts.filename,
    description: opts.description || 'VaultRealm Server Backup',
    mimeType: 'application/gzip',
  };

  if (config.folderId) {
    metadata.parents = [config.folderId];
  }

  const boundary = `-------vaultrealm_${Date.now()}`;
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metaHeader = 'Content-Type: application/json; charset=UTF-8\r\n\r\n';
  const fileHeader = 'Content-Type: application/gzip\r\n\r\n';

  const bodyParts = [
    Buffer.from(delimiter + metaHeader + JSON.stringify(metadata) + delimiter + fileHeader),
    fileData,
    Buffer.from(closeDelimiter),
  ];
  const multipartBody = Buffer.concat(bodyParts);

  const res = await fetch(`${DRIVE_UPLOAD_URL}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(multipartBody.length),
    },
    body: multipartBody,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Drive upload failed (${res.status}): ${errText}`);
  }

  const result = (await res.json()) as { id: string; name: string; webViewLink?: string };
  return {
    fileId: result.id,
    webViewLink: result.webViewLink,
  };
}

/**
 * Download a file from Google Drive directly to a local destination path.
 */
export async function downloadFromGoogleDrive(fileId: string, destFilePath: string): Promise<void> {
  const config = getStoredDriveConfig();
  if (config?.mode === 'webhook') {
    // In webhook mode, file is accessible directly or via export
    throw new Error('Direct webhook file download is not supported. Please download directly via Google Drive.');
  }

  const accessToken = await getValidAccessToken();

  const res = await fetch(`${DRIVE_API_URL}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Drive download failed (${res.status}): ${errText}`);
  }

  if (!res.body) {
    throw new Error('Google Drive download returned empty body stream.');
  }

  const fileStream = fs.createWriteStream(destFilePath);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fileStream);
}

/**
 * Delete a file from Google Drive.
 */
export async function deleteFromGoogleDrive(fileId: string): Promise<void> {
  const config = getStoredDriveConfig();
  if (!config) return;

  if (config.mode === 'webhook' && config.webhookUrl) {
    try {
      await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', fileId }),
        redirect: 'follow',
      });
    } catch (err) {
      console.warn(`[gdrive] Note: Webhook delete error for ${fileId}:`, err);
    }
    return;
  }

  try {
    const accessToken = await getValidAccessToken();
    const res = await fetch(`${DRIVE_API_URL}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok && res.status !== 404) {
      const errText = await res.text();
      console.warn(`[gdrive] Failed to delete file ${fileId} on Drive (${res.status}): ${errText}`);
    }
  } catch (err) {
    console.warn(`[gdrive] Note: Google Drive delete error for ${fileId}:`, err);
  }
}
