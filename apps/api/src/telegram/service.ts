/**
 * Telegram Bot Service & Long Polling Engine for VaultRealm.
 *
 * Enables remote server management, power actions, game settings configuration,
 * console command execution, and backups via Telegram bot commands and inline keyboards.
 */

import { eq } from 'drizzle-orm';
import { getDatabase } from '../db/index.js';
import { systemSettings, servers, users } from '../db/schema.js';
import { encryptApiKey, decryptApiKey } from '../companion/crypto.js';
import { startServer, stopServer, restartServer, getServerDetail } from '../servers/service.js';
import { getServerPropertiesData, updateServerProperty } from '../servers/properties.js';
import { executeServerCommand } from '../servers/console.js';
import { createServerBackup } from '../backups/service.js';
import { writeAudit } from '../audit/log.js';
import type {
  StoredTelegramConfig,
  PublicTelegramConfig,
  TelegramTestResult,
  TelegramUpdate,
  TelegramInlineKeyboardMarkup,
} from './types.js';

const SETTINGS_KEY = 'telegram_bot_config';

let _pollingAbortController: AbortController | null = null;
let _isPollingActive = false;
let _lastUpdateId = 0;

/**
 * Retrieve raw stored Telegram configuration from database.
 */
export function getStoredTelegramConfig(): StoredTelegramConfig | null {
  const db = getDatabase();
  const row = db.select().from(systemSettings).where(eq(systemSettings.key, SETTINGS_KEY)).all()[0];
  if (!row) return null;

  try {
    return JSON.parse(row.valueJson) as StoredTelegramConfig;
  } catch {
    return null;
  }
}

/**
 * Get effective Telegram Bot Token (checking environment variable first, then decrypted stored token).
 */
export function getEffectiveToken(): string | null {
  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (envToken) return envToken;

  const stored = getStoredTelegramConfig();
  if (stored?.tokenEnc) {
    try {
      return decryptApiKey(stored.tokenEnc);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Get public/sanitized Telegram configuration for UI display.
 */
export function getPublicTelegramConfig(): PublicTelegramConfig {
  const stored = getStoredTelegramConfig();
  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const hasEnvToken = Boolean(envToken);
  const effectiveToken = getEffectiveToken();

  return {
    configured: Boolean(effectiveToken),
    enabled: stored?.enabled ?? false,
    botUsername: stored?.botUsername,
    botFirstName: stored?.botFirstName,
    allowedChatIds: stored?.allowedChatIds || [],
    notificationsEnabled: stored?.notificationsEnabled ?? true,
    pollingActive: _isPollingActive,
    hasEnvToken,
    updatedAt: stored?.updatedAt,
  };
}

/**
 * Test Telegram bot token validity via Telegram getMe API.
 */
export async function testTelegramToken(token: string): Promise<TelegramTestResult> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return { ok: false, error: 'Telegram bot token cannot be empty.' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = (await res.json()) as { ok: boolean; result?: { username?: string; first_name?: string }; description?: string };

    if (!data.ok || !data.result) {
      return { ok: false, error: data.description || 'Invalid Telegram bot token.' };
    }

    return {
      ok: true,
      botUsername: data.result.username,
      botFirstName: data.result.first_name,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Save Telegram configuration to database.
 */
export async function saveTelegramConfig(input: {
  token?: string;
  enabled?: boolean;
  allowedChatIds?: string[];
  notificationsEnabled?: boolean;
}, userId?: string, ip?: string): Promise<PublicTelegramConfig> {
  const existing = getStoredTelegramConfig() || {
    enabled: false,
    notificationsEnabled: true,
    updatedAt: new Date().toISOString(),
  };

  let tokenEnc = existing.tokenEnc;
  let botUsername = existing.botUsername;
  let botFirstName = existing.botFirstName;

  if (input.token !== undefined) {
    const cleanToken = input.token.trim();
    if (cleanToken === '') {
      tokenEnc = undefined;
      botUsername = undefined;
      botFirstName = undefined;
    } else {
      const testRes = await testTelegramToken(cleanToken);
      if (!testRes.ok) {
        const error = new Error(testRes.error || 'Invalid Telegram token') as Error & { statusCode: number; code: string };
        error.statusCode = 400;
        error.code = 'INVALID_TELEGRAM_TOKEN';
        throw error;
      }
      tokenEnc = encryptApiKey(cleanToken);
      botUsername = testRes.botUsername;
      botFirstName = testRes.botFirstName;
    }
  }

  const updated: StoredTelegramConfig = {
    ...existing,
    enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
    tokenEnc,
    botUsername,
    botFirstName,
    allowedChatIds: input.allowedChatIds !== undefined ? input.allowedChatIds : existing.allowedChatIds,
    notificationsEnabled: input.notificationsEnabled !== undefined ? input.notificationsEnabled : existing.notificationsEnabled,
    updatedAt: new Date().toISOString(),
  };

  const db = getDatabase();
  db.insert(systemSettings)
    .values({
      key: SETTINGS_KEY,
      valueJson: JSON.stringify(updated),
      updatedAt: updated.updatedAt,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        valueJson: JSON.stringify(updated),
        updatedAt: updated.updatedAt,
      },
    })
    .run();

  if (userId) {
    writeAudit({
      userId,
      action: 'telegram.config.save',
      ip,
      data: { enabled: updated.enabled, botUsername: updated.botUsername },
    });
  }

  // Restart polling if enabled state changed
  if (updated.enabled && !_isPollingActive) {
    startTelegramPolling();
  } else if (!updated.enabled && _isPollingActive) {
    stopTelegramPolling();
  }

  return getPublicTelegramConfig();
}

// ── Telegram HTTP API Dispatchers ────────────────────────────────────────────

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

async function telegramApi(method: string, payload: unknown): Promise<TelegramApiResponse> {
  const token = getEffectiveToken();
  if (!token) throw new Error('Telegram bot token not configured.');

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as TelegramApiResponse;
}

async function sendMessage(chatId: number | string, text: string, replyMarkup?: TelegramInlineKeyboardMarkup): Promise<void> {
  try {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch {
    // Fallback without markdown if special chars fail
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

async function editMessageText(chatId: number | string, messageId: number, text: string, replyMarkup?: TelegramInlineKeyboardMarkup): Promise<void> {
  try {
    await telegramApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch {
    await telegramApi('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

// ── Server Resolution & Authorization ─────────────────────────────────────────

function getAdminUserId(): string {
  const db = getDatabase();
  const row = db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).all()[0];
  if (!row) {
    throw new Error('No administrator account is configured for Telegram actions.');
  }
  return row.id;
}

function resolveServer(identifier: string) {
  const db = getDatabase();
  const allServers = db.select().from(servers).all();
  const cleanId = identifier.trim().toLowerCase();

  // 1. Exact ID match
  let found = allServers.find((s) => s.id.toLowerCase() === cleanId);
  if (found) return found;

  // 2. Exact name match
  found = allServers.find((s) => s.name.toLowerCase() === cleanId);
  if (found) return found;

  // 3. Partial name match
  found = allServers.find((s) => s.name.toLowerCase().includes(cleanId) || s.id.toLowerCase().includes(cleanId));
  return found || null;
}

function checkAuthorization(userId: number, chatId: number): boolean {
  const config = getStoredTelegramConfig();
  if (!config?.allowedChatIds || config.allowedChatIds.length === 0) {
    return false;
  }
  const strUserId = String(userId);
  const strChatId = String(chatId);
  return config.allowedChatIds.includes(strUserId) || config.allowedChatIds.includes(strChatId);
}

// ── Command & Update Processor ────────────────────────────────────────────────

export async function processTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const callbackQuery = update.callback_query;

  if (message && message.from && message.chat) {
    const userId = message.from.id;
    const chatId = message.chat.id;
    const text = message.text?.trim() || '';

    if (!checkAuthorization(userId, chatId)) {
      await sendMessage(
        chatId,
        `⛔ *Access Denied*\nYour Telegram User ID is: \`${userId}\`\nChat ID is: \`${chatId}\`\n\nAdd this ID to VaultRealm Admin -> Telegram Settings to authorize access.`,
      );
      return;
    }

    await handleCommandOrMessage(chatId, text, userId);
  } else if (callbackQuery && callbackQuery.from && callbackQuery.message) {
    const userId = callbackQuery.from.id;
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data || '';

    if (!checkAuthorization(userId, chatId)) {
      await answerCallbackQuery(callbackQuery.id, 'Unauthorized access.');
      return;
    }

    await handleCallbackQuery(chatId, messageId, callbackQuery.id, data, userId);
  }
}

async function handleCommandOrMessage(chatId: number | string, text: string, telegramUserId: number): Promise<void> {
  void telegramUserId;
  const parts = text.split(/\s+/);
  const command = parts[0]?.toLowerCase().split('@')[0] || '';
  const args = parts.slice(1);

  const adminId = getAdminUserId();
  const auditUserId = adminId;

  switch (command) {
    case '/start':
    case '/help': {
      const helpText =
        `🎮 *VaultRealm Server Management Bot* 🎮\n\n` +
        `Manage your game servers and change server settings directly from Telegram!\n\n` +
        `*Commands:*\n` +
        `• /servers — List all servers & status\n` +
        `• /status <server> — View server metrics\n` +
        `• /settings <server> — View & configure server properties\n` +
        `• /set <server> <key> <value> — Update a property\n` +
        `• /start_server <server> — Start container\n` +
        `• /stop_server <server> — Stop container\n` +
        `• /restart_server <server> — Restart container\n` +
        `• /cmd <server> <command> — Execute RCON command\n` +
        `• /backup <server> — Create backup snapshot\n\n` +
        `_Tip: You can use server name or ID._`;
      await sendMessage(chatId, helpText);
      break;
    }

    case '/servers': {
      const db = getDatabase();
      const allServers = db.select().from(servers).all();
      if (allServers.length === 0) {
        await sendMessage(chatId, '📦 No game servers found in VaultRealm.');
        return;
      }

      let msg = `📋 *Game Servers (${allServers.length}):*\n\n`;
      const keyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [] };

      for (const s of allServers) {
        const icon = s.status === 'running' ? '🟢' : s.status === 'stopped' ? '🔴' : '⚠️';
        msg += `${icon} *${s.name}*\n`;
        msg += `   Status: \`${s.status}\` | RAM: \`${s.ramMb} MB\`\n`;
        msg += `   ID: \`${s.id}\`\n\n`;

        keyboard.inline_keyboard.push([
          { text: `⚙️ Manage: ${s.name}`, callback_data: `srv:manage:${s.id}` },
        ]);
      }

      await sendMessage(chatId, msg, keyboard);
      break;
    }

    case '/status': {
      const query = args.join(' ');
      if (!query) {
        await sendMessage(chatId, '⚠️ Please specify a server name or ID.\nUsage: `/status <server>`');
        return;
      }

      const server = resolveServer(query);
      if (!server) {
        await sendMessage(chatId, `❌ Server "${query}" not found.`);
        return;
      }

      const detail = await getServerDetail(server.id);
      const icon = detail.status === 'running' ? '🟢' : '🔴';
      let msg = `${icon} *Server Status: ${detail.name}*\n\n`;
      msg += `• *Status:* \`${detail.status}\`\n`;
      msg += `• *Template:* \`${detail.templateId}\`\n`;
      msg += `• *RAM Limit:* \`${detail.ramMb} MB\`\n`;
      msg += `• *CPU Limit:* \`${detail.cpuLimit} core(s)\`\n`;
      msg += `• *Disk Limit:* \`${detail.diskLimitMb} MB\`\n`;

      const keyboard: TelegramInlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: detail.status === 'running' ? '⏹️ Stop' : '▶️ Start', callback_data: detail.status === 'running' ? `srv:stop:${server.id}` : `srv:start:${server.id}` },
            { text: '🔄 Restart', callback_data: `srv:restart:${server.id}` },
          ],
          [
            { text: '⚙️ Settings', callback_data: `srv:settings:${server.id}` },
            { text: '💾 Backup', callback_data: `srv:backup:${server.id}` },
          ],
          [{ text: '📋 Back to List', callback_data: 'srv:list' }],
        ],
      };

      await sendMessage(chatId, msg, keyboard);
      break;
    }

    case '/settings': {
      const query = args.join(' ');
      if (!query) {
        await sendMessage(chatId, '⚠️ Please specify a server name or ID.\nUsage: `/settings <server>`');
        return;
      }

      const server = resolveServer(query);
      if (!server) {
        await sendMessage(chatId, `❌ Server "${query}" not found.`);
        return;
      }

      await sendServerSettingsView(chatId, server.id);
      break;
    }

    case '/set': {
      if (args.length < 3) {
        await sendMessage(chatId, '⚠️ Invalid usage.\nUsage: `/set <server> <key> <value>`\nExample: `/set Survival difficulty hard`');
        return;
      }

      // Try to find server name in initial words
      let server = resolveServer(args[0] || '');
      let keyIndex = 1;

      if (!server && args.length >= 4) {
        // Try two-word server name
        server = resolveServer(`${args[0] || ''} ${args[1] || ''}`);
        keyIndex = 2;
      }

      if (!server) {
        await sendMessage(chatId, `❌ Server not found for identifier "${args[0]}".`);
        return;
      }

      const key = args[keyIndex];
      const value = args.slice(keyIndex + 1).join(' ');
      if (!key || !value) {
        await sendMessage(chatId, '⚠️ Property key and value are required.');
        return;
      }

      try {
        const res = await updateServerProperty(server.id, key, value);
        writeAudit({
          userId: auditUserId,
          action: 'telegram.server.set_property',
          target: server.id,
          data: { key, value },
        });
        await sendMessage(
          chatId,
          `✅ *Property Updated!*\nServer: *${server.name}*\n\`${key}\` = \`${value}\`${res.requiresRestart ? '\n\n_⚠️ Restart server for changes to take effect._' : ''}`,
        );
      } catch (err) {
        await sendMessage(chatId, `❌ Could not update property: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case '/start_server':
    case '/stop_server':
    case '/restart_server': {
      const query = args.join(' ');
      if (!query) {
        await sendMessage(chatId, `⚠️ Please specify a server.\nUsage: \`${command} <server>\``);
        return;
      }

      const server = resolveServer(query);
      if (!server) {
        await sendMessage(chatId, `❌ Server "${query}" not found.`);
        return;
      }

      try {
        if (command === '/start_server') {
          await startServer(server.id, adminId, 'telegram-bot');
          await sendMessage(chatId, `🟢 Server *${server.name}* started successfully!`);
        } else if (command === '/stop_server') {
          await stopServer(server.id, adminId, 'telegram-bot');
          await sendMessage(chatId, `🔴 Server *${server.name}* stopped.`);
        } else if (command === '/restart_server') {
          await restartServer(server.id, adminId, 'telegram-bot');
          await sendMessage(chatId, `🔄 Server *${server.name}* restarted successfully!`);
        }
      } catch (err) {
        await sendMessage(chatId, `❌ Action failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case '/cmd': {
      if (args.length < 2) {
        await sendMessage(chatId, '⚠️ Invalid usage.\nUsage: `/cmd <server> <command>`\nExample: `/cmd Survival say Hello from Telegram`');
        return;
      }

      let server = resolveServer(args[0] || '');
      let cmdIndex = 1;

      if (!server && args.length >= 3) {
        server = resolveServer(`${args[0] || ''} ${args[1] || ''}`);
        cmdIndex = 2;
      }

      if (!server) {
        await sendMessage(chatId, `❌ Server not found for "${args[0]}".`);
        return;
      }

      const consoleCommand = args.slice(cmdIndex).join(' ');
      try {
        const result = await executeServerCommand(server.id, adminId, consoleCommand, 'telegram-bot');
        writeAudit({
          userId: auditUserId,
          action: 'telegram.server.command',
          target: server.id,
          data: { command: consoleCommand },
        });
        await sendMessage(chatId, `📟 *Command Output (${server.name}):*\n\`\`\`\n${result.output || 'Command executed successfully.'}\n\`\`\``);
      } catch (err) {
        await sendMessage(chatId, `❌ Command execution failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case '/backup': {
      const query = args.join(' ');
      if (!query) {
        await sendMessage(chatId, '⚠️ Please specify a server.\nUsage: `/backup <server>`');
        return;
      }

      const server = resolveServer(query);
      if (!server) {
        await sendMessage(chatId, `❌ Server "${query}" not found.`);
        return;
      }

      try {
        const backup = await createServerBackup(server.id, adminId, { name: 'Telegram-Backup' }, 'telegram-bot');
        const sizeMb = (backup.sizeBytes / (1024 * 1024)).toFixed(2);
        await sendMessage(chatId, `💾 *Backup Created Successfully!*\nServer: *${server.name}*\nFile: \`${backup.name}\` (${sizeMb} MB)`);
      } catch (err) {
        await sendMessage(chatId, `❌ Backup creation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    default:
      await sendMessage(chatId, '❓ Unknown command. Type `/help` for available commands.');
      break;
  }
}

async function handleCallbackQuery(chatId: number | string, messageId: number, callbackQueryId: string, data: string, telegramUserId: number): Promise<void> {
  void telegramUserId;
  const adminId = getAdminUserId();
  const auditUserId = adminId;
  const parts = data.split(':');
  const action = parts[0];
  const sub = parts[1];
  const serverId = parts[2];

  if (action === 'srv' && sub === 'list') {
    await answerCallbackQuery(callbackQueryId);
    const db = getDatabase();
    const allServers = db.select().from(servers).all();
    let msg = `📋 *Game Servers (${allServers.length}):*\n\n`;
    const keyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [] };
    for (const s of allServers) {
      const icon = s.status === 'running' ? '🟢' : '🔴';
      msg += `${icon} *${s.name}* (\`${s.status}\`)\n`;
      keyboard.inline_keyboard.push([{ text: `⚙️ Manage: ${s.name}`, callback_data: `srv:manage:${s.id}` }]);
    }
    await editMessageText(chatId, messageId, msg, keyboard);
    return;
  }

  if (action === 'srv' && sub === 'manage' && serverId) {
    await answerCallbackQuery(callbackQueryId);
    const detail = await getServerDetail(serverId);
    const icon = detail.status === 'running' ? '🟢' : '🔴';
    let msg = `${icon} *Server: ${detail.name}*\n\n`;
    msg += `• Status: \`${detail.status}\`\n`;
    msg += `• Template: \`${detail.templateId}\`\n`;
    msg += `• RAM: \`${detail.ramMb} MB\`\n`;

    const keyboard: TelegramInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: detail.status === 'running' ? '⏹️ Stop' : '▶️ Start', callback_data: detail.status === 'running' ? `srv:stop:${serverId}` : `srv:start:${serverId}` },
          { text: '🔄 Restart', callback_data: `srv:restart:${serverId}` },
        ],
        [
          { text: '⚙️ Settings', callback_data: `srv:settings:${serverId}` },
          { text: '💾 Backup', callback_data: `srv:backup:${serverId}` },
        ],
        [{ text: '📋 Back to List', callback_data: 'srv:list' }],
      ],
    };
    await editMessageText(chatId, messageId, msg, keyboard);
    return;
  }

  if (action === 'srv' && (sub === 'start' || sub === 'stop' || sub === 'restart') && serverId) {
    try {
      if (sub === 'start') await startServer(serverId, adminId, 'telegram-bot');
      if (sub === 'stop') await stopServer(serverId, adminId, 'telegram-bot');
      if (sub === 'restart') await restartServer(serverId, adminId, 'telegram-bot');

      await answerCallbackQuery(callbackQueryId, `Server ${sub}ed successfully!`);
      // Refresh manage view
      const detail = await getServerDetail(serverId);
      const icon = detail.status === 'running' ? '🟢' : '🔴';
      const msg = `${icon} *Server: ${detail.name}*\n\n• Status: \`${detail.status}\`\n• RAM: \`${detail.ramMb} MB\``;
      const keyboard: TelegramInlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: detail.status === 'running' ? '⏹️ Stop' : '▶️ Start', callback_data: detail.status === 'running' ? `srv:stop:${serverId}` : `srv:start:${serverId}` },
            { text: '🔄 Restart', callback_data: `srv:restart:${serverId}` },
          ],
          [
            { text: '⚙️ Settings', callback_data: `srv:settings:${serverId}` },
            { text: '💾 Backup', callback_data: `srv:backup:${serverId}` },
          ],
          [{ text: '📋 Back to List', callback_data: 'srv:list' }],
        ],
      };
      await editMessageText(chatId, messageId, msg, keyboard);
    } catch (err) {
      await answerCallbackQuery(callbackQueryId, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (action === 'srv' && sub === 'settings' && serverId) {
    await answerCallbackQuery(callbackQueryId);
    await updateServerSettingsView(chatId, messageId, serverId);
    return;
  }

  if (action === 'set' && serverId) {
    const propKey = sub || ''; // e.g. pvp, difficulty, gamemode, online-mode
    const dataResponse = await getServerPropertiesData(serverId);
    const prop = dataResponse.properties.find((p) => p.key === propKey);

    if (!prop) {
      await answerCallbackQuery(callbackQueryId, 'Property not found.');
      return;
    }

    let newValue = prop.value;
    if (propKey === 'pvp' || propKey === 'online-mode') {
      newValue = prop.value === 'true' ? 'false' : 'true';
    } else if (propKey === 'difficulty') {
      const cycle = ['peaceful', 'easy', 'normal', 'hard'];
      const nextIdx = (cycle.indexOf(prop.value) + 1) % cycle.length;
      newValue = cycle[nextIdx] || 'normal';
    } else if (propKey === 'gamemode') {
      const cycle = ['survival', 'creative', 'adventure', 'spectator'];
      const nextIdx = (cycle.indexOf(prop.value) + 1) % cycle.length;
      newValue = cycle[nextIdx] || 'survival';
    }

    try {
      await updateServerProperty(serverId, propKey, newValue);
      writeAudit({
        userId: auditUserId,
        action: 'telegram.server.set_property',
        target: serverId,
        data: { key: propKey, value: newValue },
      });
      await answerCallbackQuery(callbackQueryId, `Updated ${propKey} = ${newValue}`);
      await updateServerSettingsView(chatId, messageId, serverId);
    } catch (err) {
      await answerCallbackQuery(callbackQueryId, `Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  if (action === 'srv' && sub === 'backup' && serverId) {
    try {
      await answerCallbackQuery(callbackQueryId, 'Creating backup snapshot...');
      const backup = await createServerBackup(serverId, adminId, { name: 'Telegram-Backup' }, 'telegram-bot');
      await sendMessage(chatId, `💾 *Backup Created!*\nFile: \`${backup.name}\``);
    } catch (err) {
      await sendMessage(chatId, `❌ Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
}

async function sendServerSettingsView(chatId: number | string, serverId: string): Promise<void> {
  const dataResponse = await getServerPropertiesData(serverId);
  const detail = await getServerDetail(serverId);

  let msg = `⚙️ *Settings: ${detail.name}*\n\n`;
  const keyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [] };

  const keyItems = ['difficulty', 'gamemode', 'pvp', 'online-mode', 'max-players', 'hardcore', 'spawn-protection'];
  const row1: Array<{ text: string; callback_data: string }> = [];
  const row2: Array<{ text: string; callback_data: string }> = [];

  for (const item of dataResponse.properties) {
    if (keyItems.includes(item.key)) {
      const icon = item.value === 'true' ? '✅' : item.value === 'false' ? '❌' : '🔹';
      msg += `• *${item.label || item.key}:* \`${item.value}\` ${icon}\n`;

      if (['pvp', 'online-mode', 'difficulty', 'gamemode'].includes(item.key)) {
        const btnText = `${item.key}: ${item.value}`;
        const btn = { text: btnText, callback_data: `set:${item.key}:${serverId}` };
        if (row1.length < 2) row1.push(btn);
        else row2.push(btn);
      }
    }
  }

  if (row1.length > 0) keyboard.inline_keyboard.push(row1);
  if (row2.length > 0) keyboard.inline_keyboard.push(row2);

  keyboard.inline_keyboard.push([
    { text: '🔄 Refresh', callback_data: `srv:settings:${serverId}` },
    { text: '◀️ Back to Server', callback_data: `srv:manage:${serverId}` },
  ]);

  await sendMessage(chatId, msg, keyboard);
}

async function updateServerSettingsView(chatId: number | string, messageId: number, serverId: string): Promise<void> {
  const dataResponse = await getServerPropertiesData(serverId);
  const detail = await getServerDetail(serverId);

  let msg = `⚙️ *Settings: ${detail.name}*\n\n`;
  const keyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [] };

  const keyItems = ['difficulty', 'gamemode', 'pvp', 'online-mode', 'max-players', 'hardcore', 'spawn-protection'];
  const row1: Array<{ text: string; callback_data: string }> = [];
  const row2: Array<{ text: string; callback_data: string }> = [];

  for (const item of dataResponse.properties) {
    if (keyItems.includes(item.key)) {
      const icon = item.value === 'true' ? '✅' : item.value === 'false' ? '❌' : '🔹';
      msg += `• *${item.label || item.key}:* \`${item.value}\` ${icon}\n`;

      if (['pvp', 'online-mode', 'difficulty', 'gamemode'].includes(item.key)) {
        const btnText = `${item.key}: ${item.value}`;
        const btn = { text: btnText, callback_data: `set:${item.key}:${serverId}` };
        if (row1.length < 2) row1.push(btn);
        else row2.push(btn);
      }
    }
  }

  if (row1.length > 0) keyboard.inline_keyboard.push(row1);
  if (row2.length > 0) keyboard.inline_keyboard.push(row2);

  keyboard.inline_keyboard.push([
    { text: '🔄 Refresh', callback_data: `srv:settings:${serverId}` },
    { text: '◀️ Back to Server', callback_data: `srv:manage:${serverId}` },
  ]);

  await editMessageText(chatId, messageId, msg, keyboard);
}

// ── Long Polling Loop ─────────────────────────────────────────────────────────

export function startTelegramPolling(): void {
  const config = getStoredTelegramConfig();
  if (!config || !config.enabled) return;

  const token = getEffectiveToken();
  if (!token) return;

  if (_isPollingActive) return;

  _pollingAbortController = new AbortController();
  _isPollingActive = true;

  console.log('[TelegramBot] Starting long polling loop...');

  (async () => {
    while (_isPollingActive && !_pollingAbortController?.signal.aborted) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${_lastUpdateId + 1}&timeout=30`, {
          signal: _pollingAbortController?.signal,
        });
        const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };

        if (data.ok && data.result && Array.isArray(data.result)) {
          for (const update of data.result) {
            _lastUpdateId = Math.max(_lastUpdateId, update.update_id);
            processTelegramUpdate(update).catch((err) => {
              console.error('[TelegramBot] Error processing update:', err);
            });
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          break;
        }
        console.error('[TelegramBot] Polling network error:', err);
        // Wait 5s before retrying after network error
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    _isPollingActive = false;
    console.log('[TelegramBot] Polling loop stopped.');
  })();
}

export function stopTelegramPolling(): void {
  if (_pollingAbortController) {
    _pollingAbortController.abort();
    _pollingAbortController = null;
  }
  _isPollingActive = false;
}

export function isTelegramPollingActive(): boolean {
  return _isPollingActive;
}

/**
 * Broadcast notification message to all configured allowed chat IDs.
 */
export async function sendTelegramNotification(message: string): Promise<void> {
  const config = getStoredTelegramConfig();
  if (!config || !config.notificationsEnabled || !config.allowedChatIds || config.allowedChatIds.length === 0) {
    return;
  }

  const token = getEffectiveToken();
  if (!token) return;

  for (const chatId of config.allowedChatIds) {
    try {
      await sendMessage(chatId, `🔔 *VaultRealm Alert*\n\n${message}`);
    } catch (err) {
      console.error(`[TelegramBot] Failed to send notification to chat ${chatId}:`, err);
    }
  }
}
