/**
 * Telegram Bot API types and configuration definitions for VaultRealm.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  inline_message_id?: string;
  chat_instance?: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface StoredTelegramConfig {
  enabled: boolean;
  tokenEnc?: string;
  botUsername?: string;
  botFirstName?: string;
  allowedChatIds?: string[];
  notificationsEnabled: boolean;
  updatedAt: string;
}

export interface PublicTelegramConfig {
  configured: boolean;
  enabled: boolean;
  botUsername?: string;
  botFirstName?: string;
  allowedChatIds?: string[];
  notificationsEnabled: boolean;
  pollingActive: boolean;
  hasEnvToken: boolean;
  updatedAt?: string;
}

export interface TelegramTestResult {
  ok: boolean;
  botUsername?: string;
  botFirstName?: string;
  error?: string;
}
