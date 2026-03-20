/**
 * Raw Telegram Bot API — direct fetch calls, no framework.
 *
 * Just a base `tg()` function that handles the fetch boilerplate,
 * plus types for the Telegram objects we use.
 */

// ─── Telegram Types ──────────────────────────────

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  entities?: TgEntity[];
  voice?: TgVoice;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

// ─── Base API Call ───────────────────────────────

const TG_BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Call any Telegram Bot API method directly.
 *
 * Usage:
 *   await tg('sendMessage', { chat_id: 123, text: 'hello' })
 *   await tg('editMessageText', { chat_id: 123, message_id: 456, text: 'updated' })
 *   await tg('sendMessageDraft', { chat_id: 123, draft_id: 1, text: 'streaming...' })
 */
export async function tg<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  const res = await fetch(`${TG_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json() as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

/**
 * Fire-and-forget version — swallows errors silently.
 * Use for non-critical calls like sendChatAction or sendMessageDraft.
 */
export function tgSilent(method: string, params: Record<string, any> = {}): void {
  tg(method, params).catch(() => {});
}
