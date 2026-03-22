import crypto from 'node:crypto';
import { isAddress } from 'viem';
import { tg, tgSilent, TgUpdate } from './client';
import { runToppaAgent } from '../../agent/graph';
import { calculateTotalPayment } from '../../blockchain/x402';
import { WalletManager } from '../../wallet/manager';
import { InMemoryWalletStore } from '../../wallet/store';
import { MongoWalletStore } from '../../wallet/mongo-store';
import { PendingOrderStore, PendingOrder, generateOrderId } from '../pending-orders';
import { handleCallback, storePendingWithdrawal } from './handlers';
import { userSettingsStore } from '../user-settings';
import { IS_TESTNET, TOKEN_SYMBOL, EXPLORER_BASE } from '../../shared/constants';
import { startScheduler, startRecurringScheduler, stopScheduler, markTaskCompleted, markTaskFailed, ScheduledTask, getUserScheduledTasks, getScheduledTasksByChatId, getRecurringTasksByChatId, adminCancelScheduledTask, adminCancelRecurringTask } from '../../agent/scheduler';
import { clearConversationHistory } from '../../agent/memory';
import { startHeartbeat, stopHeartbeat } from '../../agent/heartbeat';
import { trackActivity, setProactiveEnabled, getUserActivity } from '../../agent/user-activity';
import { getUserGoals } from '../../agent/goals';
import { getFxRate } from '../../apis/reloadly';
import { startSellOrderPoller, stopSellOrderPoller } from '../sell-order-poller';
import { enableGroup, getGroup, isGroupAdmin, getGroupBalance, contributeToGroup, groupWithdraw, getGroupTransactions, getMemberContributions, setPollThreshold, createGroupPoll, setPollMessageInfo, getPollByTgPollId, getPollById, recordPollVote, closePoll, setPollingEnabled, getMostRecentActivePoll, getActivePolls } from '../groups';
import { recordGroupMsg, buildGroupContext as buildGroupCtx, UserRateLimit, RATE_LIMIT_WINDOW, MAX_REQUESTS_PER_WINDOW, DAILY_SPENDING_LIMIT, VERIFIED_SPENDING_LIMIT, SPENDING_RESET_WINDOW } from '../group-context';
import { getDailySpendingLimit, createVerificationSession, getUserVerificationStatus, formatVerificationMessage, formatAlreadyVerifiedMessage, VERIFIED_DAILY_LIMIT } from '../../blockchain/self-verification';

// ─────────────────────────────────────────────────
// Wallet & Order Infrastructure
// ─────────────────────────────────────────────────

const walletStore = process.env.MONGODB_URI
  ? new MongoWalletStore()
  : new InMemoryWalletStore();
const walletManager = new WalletManager(walletStore);
const pendingOrders = new PendingOrderStore();

// Bot info — populated at startup via getMe()
let botId = 0;
let botUsername = '';

// ─────────────────────────────────────────────────
// Group @Mention Infrastructure
// ─────────────────────────────────────────────────

/** Check if the bot is @mentioned in a message or if the message replies to the bot. */
function isBotMentioned(msg: import('./client').TgMessage): boolean {
  if (msg.entities && botUsername) {
    for (const e of msg.entities) {
      if (e.type === 'mention' && msg.text) {
        const mention = msg.text.slice(e.offset, e.offset + e.length);
        if (mention.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
      }
    }
  }
  if (msg.reply_to_message?.from?.id === botId) return true;
  return false;
}

/** Build Telegram-specific group context (extracts quoted text from reply_to_message). */
function buildTgGroupContext(msg: import('./client').TgMessage, groupId: string): string {
  return buildGroupCtx(groupId, msg.reply_to_message?.text);
}

// Cleanup stale rate limit entries every 5 minutes
setInterval(() => {
  pendingOrders.cleanup().catch(() => {});
  const now = Date.now();
  for (const [userId, limit] of userRateLimits) {
    if (now - limit.lastReset > 60 * 60 * 1000) {
      userRateLimits.delete(userId);
    }
  }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────
// Security: Rate Limiting & Spending Limits
// ─────────────────────────────────────────────────

const userRateLimits = new Map<string, UserRateLimit>();

let _spendingIndexCreated = false;
async function loadSpendingFromDb(userId: string): Promise<{ totalSpent: number; spendingResetDate: number }> {
  try {
    const { getDb } = await import('../../wallet/mongo-store');
    const db = await getDb();
    if (!_spendingIndexCreated) {
      await db.collection('spending_limits').createIndex({ userId: 1 });
      _spendingIndexCreated = true;
    }
    const doc = await db.collection('spending_limits').findOne({ userId });
    if (doc && Date.now() - doc.spendingResetDate < SPENDING_RESET_WINDOW) {
      return { totalSpent: doc.totalSpent, spendingResetDate: doc.spendingResetDate };
    }
  } catch {}
  return { totalSpent: 0, spendingResetDate: Date.now() };
}

function persistSpendingToDb(userId: string, totalSpent: number, spendingResetDate: number) {
  import('../../wallet/mongo-store').then(({ getDb }) =>
    getDb().then(db =>
      db.collection('spending_limits').updateOne(
        { userId },
        { $set: { userId, totalSpent, spendingResetDate, updatedAt: new Date() } },
        { upsert: true },
      ),
    ),
  ).catch((err: any) => console.error('[Spending Persist Error]', err.message));
}

async function checkRateLimit(userId: string): Promise<{ allowed: boolean; reason?: string }> {
  const now = Date.now();
  let userLimit = userRateLimits.get(userId);

  if (!userLimit || now - userLimit.lastReset > RATE_LIMIT_WINDOW) {
    const dbSpending = await loadSpendingFromDb(userId);
    userLimit = {
      requestCount: 0,
      lastReset: now,
      totalSpent: dbSpending.totalSpent,
      spendingResetDate: dbSpending.spendingResetDate,
    };
    userRateLimits.set(userId, userLimit);
  }

  if (userLimit.requestCount >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, reason: 'Slow down a bit! Try again in a few seconds.' };
  }

  if (now - userLimit.spendingResetDate > SPENDING_RESET_WINDOW) {
    userLimit.totalSpent = 0;
    userLimit.spendingResetDate = now;
    persistSpendingToDb(userId, 0, now);
  }

  // Self Protocol tiered limits: verified users get higher daily cap
  const userDailyLimit = await getDailySpendingLimit(userId);
  if (userLimit.totalSpent >= userDailyLimit) {
    const isLowTier = userDailyLimit === DAILY_SPENDING_LIMIT;
    const reason = isLowTier
      ? `Daily limit of $${userDailyLimit} reached. Verify with Self Protocol to unlock $${VERIFIED_SPENDING_LIMIT}/day! Use /verify to get started.`
      : `Daily spending limit of $${userDailyLimit} reached. Try again tomorrow.`;
    return { allowed: false, reason };
  }

  userLimit.requestCount++;
  return { allowed: true };
}

function recordSpending(userId: string, amount: number) {
  let userLimit = userRateLimits.get(userId);
  if (!userLimit) {
    // Entry was evicted from in-memory cache — recreate with this spending
    userLimit = {
      requestCount: 0,
      lastReset: Date.now(),
      totalSpent: 0,
      spendingResetDate: Date.now(),
    };
    userRateLimits.set(userId, userLimit);
  }
  userLimit.totalSpent += amount;
  persistSpendingToDb(userId, userLimit.totalSpent, userLimit.spendingResetDate);
}

// ─────────────────────────────────────────────────
// Security: Input Sanitization
// ─────────────────────────────────────────────────

function sanitizeTelegramInput(input: string): string {
  if (input.length > 500) {
    throw new Error('Message too long. Please keep it under 500 characters.');
  }

  // Normalize Unicode tricks (homoglyphs, zero-width chars, encoded variants)
  const normalized = input
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '') // Zero-width chars
    .replace(/[\u0400-\u04FF]/g, (c) => { // Common Cyrillic homoglyphs → Latin
      const map: Record<string, string> = { '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0455': 's', '\u0456': 'i', '\u0445': 'x' };
      return map[c] || c;
    });

  const dangerous = [
    'ignore previous', 'ignore all', 'new instructions', 'forget everything',
    'system:', 'admin:', 'sudo', 'root:', '<script>', '<|im_end|>', '<|im_start|>',
    'disregard', 'override', 'jailbreak', 'developer mode',
    '\\[system\\]', '\\{system\\}', '<\\|system\\|>', '<\\|user\\|>',
    'pretend you', 'act as if', 'roleplay as',
    'ignore above', 'ignore the above', 'ignore your instructions',
    'bypass', 'do anything now',
  ];

  for (const phrase of dangerous) {
    if (new RegExp(phrase, 'gi').test(normalized)) {
      throw new Error('Message contains potentially malicious content. Please rephrase.');
    }
  }

  return input; // Return original (not normalized) — normalization was only for detection
}

// ─────────────────────────────────────────────────
// Post-processing: Strip Markdown from AI Responses
// ─────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  return text
    // Bold: **text** (greedy-safe, handles emojis inside)
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    // Italic: *text* or _text_ (word-boundary safe)
    .replace(/(?<!\w)\*(.+?)\*(?!\w)/gs, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/gs, '$1')
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/gs, '$1')
    // Headers: # text
    .replace(/^#{1,6}\s+/gm, '')
    // Code blocks: ```code```
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/g, '').trim())
    // Inline code: `code`
    .replace(/`([^`]+)`/g, '$1')
    // Links: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Bullet points: - or * at start of line
    .replace(/^[\s]*[-*]\s+/gm, '• ')
    // Collapse excessive newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────────
// Telegram Message Splitter (4096 char limit)
// ─────────────────────────────────────────────────

const TG_MSG_LIMIT = 4096;

async function sendLongMessage(chatId: number, text: string, opts?: { parse_mode?: string; reply_markup?: any }) {
  if (text.length <= TG_MSG_LIMIT) {
    await tg('sendMessage', { chat_id: chatId, text, ...opts });
    return;
  }
  // Split on double newlines first, then single newlines, then hard cut
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_MSG_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n\n', TG_MSG_LIMIT);
    if (cut < TG_MSG_LIMIT / 2) cut = remaining.lastIndexOf('\n', TG_MSG_LIMIT);
    if (cut < TG_MSG_LIMIT / 2) cut = TG_MSG_LIMIT;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  for (let i = 0; i < chunks.length; i++) {
    // Only attach reply_markup to the last chunk
    const extra = i === chunks.length - 1 ? opts : { parse_mode: opts?.parse_mode };
    await tg('sendMessage', { chat_id: chatId, text: chunks[i], ...extra });
  }
}

// ─────────────────────────────────────────────────
// Telegram Document Sender (for PDF/Excel reports)
// ─────────────────────────────────────────────────

async function sendTelegramDocument(chatId: number, buffer: Buffer, filename: string, caption: string) {
  const formData = new FormData();
  formData.append('chat_id', chatId.toString());
  formData.append('caption', caption);
  formData.append('document', new Blob([buffer]), filename);

  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sendDocument failed: ${text.slice(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────
// Command Handlers
// ─────────────────────────────────────────────────

async function cmdStart(chatId: number, userId: string) {
  const { address } = await walletManager.getOrCreateWallet(userId);
  const explorerUrl = `${EXPLORER_BASE}/address/${address}`;

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `Welcome to Toppa!\n\n` +
      `Your Celo wallet:\n\`${address}\`\n\n` +
      `Network: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}\n` +
      `Token: ${TOKEN_SYMBOL}\n\n` +
      `Deposit ${TOKEN_SYMBOL} on Celo to get started.\n` +
      `Other tokens sent here won't show in-app, but you can recover them via /settings.\n\n` +
      `Just tell me what you need in plain English!`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [
        { text: '📱 Send Airtime', callback_data: 'quick_airtime' },
        { text: '📶 Send Data', callback_data: 'quick_data' },
      ],
      [
        { text: '💡 Pay Bill', callback_data: 'quick_bill' },
        { text: '🎁 Gift Card', callback_data: 'quick_giftcard' },
      ],
      [
        { text: '💰 My Wallet', callback_data: `balance_${userId}` },
        { text: '🔍 Celoscan', url: explorerUrl },
      ],
    ]},
  });
}

async function cmdWallet(chatId: number, userId: string, groupId?: string | null) {
  try {
    // Show personal wallet
    const { balance, address } = await walletManager.getBalance(userId);
    const explorerUrl = `${EXPLORER_BASE}/address/${address}`;

    let text =
      `💰 Your Toppa Wallet\n\n` +
      `Address:\n\`${address}\`\n\n` +
      `Balance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\n` +
      `Network: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}`;

    // If in a group chat with an enabled group wallet, also show group balance
    if (groupId) {
      const group = await getGroup(groupId);
      if (group) {
        const { balance: gBal } = await getGroupBalance(group, walletManager);
        text += `\n\n👥 Group Wallet (${group.name})\n` +
          `Address: \`${group.walletAddress}\`\n` +
          `Balance: ${parseFloat(gBal).toFixed(2)} ${TOKEN_SYMBOL}`;
      }
    }

    text += `\n\nTap address above to copy, then deposit ${TOKEN_SYMBOL} to fund your wallet.`;

    await tg('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🔍 View on Celoscan', url: explorerUrl }],
        [{ text: '🔄 Refresh Balance', callback_data: `balance_${userId}` }],
      ]},
    });
  } catch (error: any) {
    console.error('[Wallet Error]', error.message);
    await tg('sendMessage', { chat_id: chatId, text: '❌ Could not fetch wallet info. Please try again.' });
  }
}

async function cmdWithdraw(chatId: number, userId: string, text: string) {
  const parts = text.split(' ');

  if (parts.length < 3) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Usage: /withdraw <celo_address> <amount>\nExample: /withdraw 0x1234...abcd 10.00`,
    });
    return;
  }

  const toAddress = parts[1];
  const amount = parseFloat(parts[2]);

  if (!isAddress(toAddress)) {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `❌ Invalid Address\n\n` +
        `Please provide a valid Celo/Ethereum address.\n\n` +
        `Example:\n\`0x1234567890abcdef1234567890abcdef12345678\``,
      parse_mode: 'Markdown',
    });
    return;
  }
  if (isNaN(amount) || !isFinite(amount) || amount <= 0 || amount > 10000) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `❌ Invalid Amount\n\nAmount must be a positive number.\nExample: /withdraw ${toAddress.slice(0, 10)}... 10.5`,
    });
    return;
  }

  const wdId = storePendingWithdrawal(userId, amount, toAddress);
  await tg('sendMessage', {
    chat_id: chatId,
    text: `Withdraw ${amount} ${TOKEN_SYMBOL} to\n${toAddress}?`,
    reply_markup: { inline_keyboard: [
      [{ text: 'Confirm Withdrawal', callback_data: `wd_${wdId}` }],
      [{ text: 'Cancel', callback_data: `wdc_${wdId}` }],
    ]},
  });
}

async function cmdHelp(chatId: number, isGroupChat = false) {
  let text =
    `Toppa Commands\n\n` +
    `/start - Create your wallet & get started\n` +
    `/wallet - Check balance & deposit address\n` +
    `/withdraw <address> <amount> - Withdraw ${TOKEN_SYMBOL}\n` +
    `/rate <country> - Check FX rate (e.g. /rate NG)\n` +
    `/settings - Wallet settings & export key\n` +
    `/status - Your profile, instructions & tasks\n` +
    `/silent - Toggle proactive messages on/off\n` +
    `/clear - Clear conversation memory\n` +
    `/verify - Verify identity (unlock $200/day limit)\n` +
    `/cancel - Cancel pending order\n` +
    `/help - Show this help message\n`;

  if (isGroupChat) {
    text +=
      `\nGroup Commands\n` +
      `/group enable - Enable group wallet (admin)\n` +
      `/group - Show group wallet info\n` +
      `/contribute <amount> - Contribute cUSD to group\n` +
      `/group_withdraw <address> <amount> - Admin withdraw\n` +
      `/threshold <percent> - Set poll approval % (admin)\n` +
      `/poll - Admin: manage polls (cancel/approve/off/on)\n` +
      `/tasks - Admin: view group scheduled tasks\n` +
      `/task cancel <id> - Admin: cancel a task\n`;
  }

  text +=
    `\nJust tell me what you need:\n` +
    `• "Send $5 airtime to +234... in Nigeria"\n` +
    `• "Buy a $25 Steam gift card"\n` +
    `• "Pay my DStv bill for 1234567"\n` +
    `• "Send airtime to my brother at 5pm"\n` +
    `• "Remember my sister's number is +234..."\n\n` +
    `I support 170+ countries, 800+ operators, and 300+ gift card brands!`;

  await tg('sendMessage', { chat_id: chatId, text });
}

async function cmdRate(chatId: number, text: string) {
  const parts = text.split(' ');
  const countryCode = parts[1]?.toUpperCase();

  if (!countryCode || countryCode.length < 2 || countryCode.length > 3) {
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `Usage: /rate <country_code>\n\nExamples:\n` +
        `/rate NG - Nigeria (NGN)\n` +
        `/rate KE - Kenya (KES)\n` +
        `/rate GH - Ghana (GHS)\n` +
        `/rate ZA - South Africa (ZAR)`,
    });
    return;
  }

  try {
    const fxData = await getFxRate(countryCode);
    if (!fxData) {
      await tg('sendMessage', { chat_id: chatId, text: `No rate available for ${countryCode}. Check the country code and try again.` });
      return;
    }

    const { rate, currencyCode } = fxData;
    const examples = [1, 5, 10, 25].map(usd => {
      const local = Math.round(usd * rate);
      return `${usd} ${TOKEN_SYMBOL} = ${local.toLocaleString('en-US')} ${currencyCode}`;
    }).join('\n');

    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `Rate for ${countryCode} (${currencyCode})\n\n` +
        `1 ${TOKEN_SYMBOL} = ${rate.toLocaleString('en-US')} ${currencyCode}\n\n` +
        `${examples}\n\n` +
        `This is the Toppa delivery rate for airtime/data.`,
    });
  } catch {
    await tg('sendMessage', { chat_id: chatId, text: `Could not fetch rate for ${countryCode}. Try again later.` });
  }
}

async function cmdSettings(chatId: number, userId: string, chatType: string) {
  if (chatType !== 'private') {
    await tg('sendMessage', { chat_id: chatId, text: 'For security, use this command in a private chat with me.' });
    return;
  }

  const settings = await userSettingsStore.get(userId);
  const autoReviewStatus = settings.autoReviewEnabled ? 'ON ✅' : 'OFF ❌';

  await tg('sendMessage', {
    chat_id: chatId,
    text: `⚙️ Wallet Settings\n\nChoose an option:`,
    reply_markup: { inline_keyboard: [
      [{ text: `⭐ Auto-Review: ${autoReviewStatus}`, callback_data: `toggle_autoreview_${userId}` }],
      [{ text: '🔑 Export Private Key', callback_data: `export_warning_${userId}` }],
      [{ text: '📊 Transaction History', callback_data: `history_${userId}` }],
      [{ text: '💰 Check Balance', callback_data: `balance_${userId}` }],
      [{ text: '❌ Close', callback_data: `settings_close_${userId}` }],
    ]},
  });
}

async function cmdHistory(chatId: number) {
  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `📊 Transaction History\n\nComing soon: View your recent airtime, data, bills, and gift card purchases.\n\n` +
      `For now, check your wallet address on Celoscan:\n${EXPLORER_BASE}`,
  });
}

async function cmdCancel(chatId: number, userId: string) {
  const order = await pendingOrders.getByUser(userId);
  if (!order) {
    await tg('sendMessage', { chat_id: chatId, text: 'You have no pending orders.' });
    return;
  }

  // Only cancel orders that are waiting for user action — never cancel mid-processing orders
  if (order.status === 'processing') {
    await tg('sendMessage', { chat_id: chatId, text: 'Your order is currently processing and cannot be cancelled.' });
    return;
  }

  const transitioned = await pendingOrders.atomicTransition(
    order.orderId, ['pending_confirmation', 'pending_payment'], 'cancelled',
  );
  if (!transitioned) {
    await tg('sendMessage', { chat_id: chatId, text: 'Order is already processing or expired.' });
    return;
  }

  await pendingOrders.remove(order.orderId);
  await tg('sendMessage', { chat_id: chatId, text: `❌ Order cancelled\n\n${order.description}` });
}

async function cmdClear(chatId: number, userId: string) {
  await clearConversationHistory(userId);
  await tg('sendMessage', { chat_id: chatId, text: 'Conversation memory cleared. I won\'t remember our previous chats.' });
}

async function cmdSilent(chatId: number, userId: string) {
  const activity = await getUserActivity(userId);
  const currentlyEnabled = activity?.proactiveEnabled ?? true;
  const newState = !currentlyEnabled;
  await setProactiveEnabled(userId, newState);
  await tg('sendMessage', {
    chat_id: chatId,
    text: newState
      ? 'Proactive messages enabled. I\'ll reach out when I have something useful for you.'
      : 'Proactive messages disabled. I\'ll only respond when you message me.',
  });
}

async function cmdStatus(chatId: number, userId: string) {
  const [goals, tasks, activity] = await Promise.all([
    getUserGoals(userId),
    getUserScheduledTasks(userId),
    getUserActivity(userId),
  ]);

  const proactiveStatus = (activity?.proactiveEnabled ?? true) ? 'ON' : 'OFF';
  const country = activity?.country || 'Not detected yet';

  let msg = `Your Toppa Profile\n\nProactive messages: ${proactiveStatus} (toggle with /silent)\nDetected country: ${country}\n\n`;

  if (goals.length > 0) {
    msg += `Saved Instructions (${goals.length}):\n`;
    goals.slice(0, 10).forEach((g, i) => {
      msg += `${i + 1}. [${g.category}] ${g.instruction}\n`;
    });
    if (goals.length > 10) msg += `... and ${goals.length - 10} more\n`;
    msg += '\n';
  } else {
    msg += 'No saved instructions. Tell me things to remember!\n\n';
  }

  if (tasks.length > 0) {
    msg += `Scheduled Tasks (${tasks.length}):\n`;
    tasks.forEach((t, i) => {
      msg += `${i + 1}. ${t.description} — ${new Date(t.scheduledAt).toLocaleString('en-US')}\n`;
    });
  } else {
    msg += 'No scheduled tasks.';
  }

  await tg('sendMessage', { chat_id: chatId, text: msg });
}

async function cmdExport(chatId: number) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: `To export your private key, use /settings\n\nThis must be done in a private chat for security.`,
  });
}

// ─────────────────────────────────────────────────
// Self Protocol Verification Command
// ─────────────────────────────────────────────────

async function cmdVerify(chatId: number, userId: string) {
  try {
    const { link, alreadyVerified } = await createVerificationSession(
      userId,
      'telegram',
      chatId.toString(),
    );

    if (alreadyVerified) {
      const status = await getUserVerificationStatus(userId);
      await tg('sendMessage', {
        chat_id: chatId,
        text: formatAlreadyVerifiedMessage(status.verifiedAt),
      });
      return;
    }

    await tg('sendMessage', {
      chat_id: chatId,
      text: formatVerificationMessage(link),
      reply_markup: {
        inline_keyboard: [[
          { text: 'Verify with Self', url: link },
        ]],
      },
    });
  } catch (err: any) {
    console.error('[Verify] Error:', err.message);
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Verification is temporarily unavailable. Please try again later.',
    });
  }
}

// ─────────────────────────────────────────────────
// Voice Message Handler (Deepgram transcription)
// ─────────────────────────────────────────────────

const MAX_VOICE_DURATION = 120; // 2 minutes max

async function handleVoiceMessage(chatId: number, userId: string, fileId: string, duration: number) {
  if (duration > MAX_VOICE_DURATION) {
    await tg('sendMessage', { chat_id: chatId, text: 'Voice message too long — keep it under 2 minutes.' });
    return;
  }

  tgSilent('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    // 1. Get file path from Telegram
    const file = await tg<{ file_path: string }>('getFile', { file_id: fileId });
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    // 2. Download the voice file
    const audioResponse = await fetch(fileUrl);
    if (!audioResponse.ok) throw new Error('Failed to download voice file');
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    // 3. Transcribe with Deepgram
    const dgKey = process.env.DEEPGRAM_API_KEY;
    if (!dgKey) throw new Error('DEEPGRAM_API_KEY not set');

    const dgResponse = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${dgKey}`,
        'Content-Type': 'audio/ogg',
      },
      body: audioBuffer,
    });

    if (!dgResponse.ok) throw new Error(`Deepgram ${dgResponse.status}: ${await dgResponse.text()}`);
    const dgResult = await dgResponse.json() as any;
    const text = dgResult?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
    if (!text) {
      await tg('sendMessage', { chat_id: chatId, text: "Couldn't understand the voice message. Try again or type your request." });
      return;
    }

    console.log(`[Voice] User ${userId}: "${text.slice(0, 80)}..." (${duration}s)`);

    // 4. Feed transcribed text to the normal message handler
    await handleTextMessage(chatId, userId, text);
  } catch (err: any) {
    console.error('[Voice] Transcription failed:', err.message);
    await tg('sendMessage', { chat_id: chatId, text: "Couldn't process that voice message. Try typing your request instead." });
  }
}

// ─────────────────────────────────────────────────
// Text Message Handler (AI Agent + Order Detection)
// ─────────────────────────────────────────────────

// Per-user message lock — prevents duplicate processing when users spam messages
const userMessageLock = new Map<string, number>(); // userId → timestamp

async function handleTextMessage(chatId: number, userId: string, userMessage: string, _groupId?: string | null, _groupContext?: string) {
  const msgStart = Date.now();

  // Reject if this user already has a message being processed (prevents duplicates)
  const lockTime = userMessageLock.get(userId);
  if (lockTime && Date.now() - lockTime < 120_000) {
    return; // Silently drop — user will see response from the in-flight message
  }
  userMessageLock.set(userId, Date.now());

  trackActivity(userId, chatId).catch(() => {});

  try {
    const rateLimitCheck = await checkRateLimit(userId);
    if (!rateLimitCheck.allowed) {
      await tg('sendMessage', { chat_id: chatId, text: rateLimitCheck.reason! });
      return;
    }

    const sanitizedMessage = sanitizeTelegramInput(userMessage);

    // Strip @botname from message and prepend group context for the agent
    let messageForAgent = sanitizedMessage;
    if (botUsername) {
      messageForAgent = messageForAgent.replace(new RegExp(`@${botUsername}\\b`, 'gi'), '').trim();
    }
    if (_groupContext) {
      messageForAgent = `${_groupContext}\n\n${messageForAgent}`;
    }

    tgSilent('sendChatAction', { chat_id: chatId, action: 'typing' });

    // Refresh typing indicator every 4s (Telegram expires it after ~5s)
    const typingInterval = setInterval(() => {
      tgSilent('sendChatAction', { chat_id: chatId, action: 'typing' });
    }, 4000);

    const balanceStart = Date.now();
    const { balance, address } = await walletManager.getBalance(userId);
    console.log(`[Timing] Balance fetch: ${Date.now() - balanceStart}ms`);

    let response: string;
    try {
      const userTz = await userSettingsStore.getTimezone(userId);
      const result = await runToppaAgent(messageForAgent, {
        userAddress: userId,
        source: 'telegram',
        rateLimited: true,
        walletAddress: address,
        walletBalance: balance,
        chatId,
        timezone: userTz,
        groupId: _groupId || undefined,
      });
      response = result.response;
    } finally {
      clearInterval(typingInterval);
    }

    // Check if agent returned an order confirmation JSON
    // Try direct parse first (short-circuit returns pure JSON), then extract from text
    let orderData: any = null;
    try {
      const parsed = JSON.parse(response);
      if (parsed?.type === 'order_confirmation') orderData = parsed;
    } catch {
      // Not pure JSON — try to extract embedded JSON with brace matching
      const idx = response.indexOf('"order_confirmation"');
      if (idx !== -1) {
        // Find the opening { before "order_confirmation"
        let start = response.lastIndexOf('{', idx);
        if (start !== -1) {
          // Match braces to find the correct closing }
          let depth = 0;
          for (let j = start; j < response.length; j++) {
            if (response[j] === '{') depth++;
            else if (response[j] === '}') depth--;
            if (depth === 0) {
              try {
                const extracted = JSON.parse(response.slice(start, j + 1));
                if (extracted?.type === 'order_confirmation') orderData = extracted;
              } catch { /* invalid JSON segment */ }
              break;
            }
          }
        }
      }
    }

    // Check for poll creation request from agent
    let pollData: any = null;
    try {
      const parsed = JSON.parse(response);
      if (parsed?.type === 'create_poll') pollData = parsed;
    } catch {
      const idx = response.indexOf('"create_poll"');
      if (idx !== -1) {
        let start = response.lastIndexOf('{', idx);
        if (start !== -1) {
          let depth = 0;
          for (let j = start; j < response.length; j++) {
            if (response[j] === '{') depth++;
            else if (response[j] === '}') depth--;
            if (depth === 0) {
              try {
                const extracted = JSON.parse(response.slice(start, j + 1));
                if (extracted?.type === 'create_poll') pollData = extracted;
              } catch { /* invalid JSON */ }
              break;
            }
          }
        }
      }
    }

    if (pollData && _groupId) {
      try {
        await sendGroupPoll({
          chatId,
          groupId: _groupId,
          createdBy: userId,
          description: pollData.description,
          service: pollData.service,
          amount: pollData.amount,
          details: pollData.details,
        });
      } catch (err: any) {
        await tg('sendMessage', { chat_id: chatId, text: `Failed to create poll: ${err.message}` });
      }
      console.log(`[Timing] Total message handling: ${Date.now() - msgStart}ms`);
      return;
    }

    // Check for statement report to send as document
    let reportData: any = null;
    try {
      const parsed = JSON.parse(response);
      if (parsed?.type === 'statement_report') reportData = parsed;
    } catch {
      const idx = response.indexOf('"statement_report"');
      if (idx !== -1) {
        let start = response.lastIndexOf('{', idx);
        if (start !== -1) {
          let depth = 0;
          for (let j = start; j < response.length; j++) {
            if (response[j] === '{') depth++;
            else if (response[j] === '}') depth--;
            if (depth === 0) {
              try {
                const extracted = JSON.parse(response.slice(start, j + 1));
                if (extracted?.type === 'statement_report') reportData = extracted;
              } catch { /* invalid JSON */ }
              break;
            }
          }
        }
      }
    }

    if (reportData?.reportId) {
      try {
        const { getReportFromCache } = await import('../../agent/tools');
        const report = getReportFromCache(reportData.reportId);
        if (report) {
          await sendTelegramDocument(chatId, report.buffer, report.filename, `Your ${reportData.format?.toUpperCase() || ''} statement is ready.`);
        } else {
          await tg('sendMessage', { chat_id: chatId, text: 'Report expired. Please generate it again.' });
        }
      } catch (err: any) {
        await tg('sendMessage', { chat_id: chatId, text: `Failed to send report: ${err.message}` });
      }
      console.log(`[Timing] Total message handling: ${Date.now() - msgStart}ms`);
      return;
    }

    if (orderData) {
      // Block new orders while another is processing (payment in-flight / service executing).
      // The wallet lock would catch this at pay_accept time anyway, but warning early is better UX.
      // Staleness guard: if a processing order is >3 min old, the server likely crashed mid-execution.
      // The in-memory wallet lock resets on restart, but the MongoDB order stays stuck.
      // Mark it failed and let the user continue rather than blocking them indefinitely.
      const STALE_PROCESSING_MS = 60 * 1000; // 1 minute — most orders complete in <30s
      const activeOrder = await pendingOrders.getByUser(userId);
      if (activeOrder?.status === 'processing') {
        const orderAge = Date.now() - activeOrder.createdAt;
        if (orderAge > STALE_PROCESSING_MS) {
          console.warn(`[StaleOrder] Order ${activeOrder.orderId} stuck in processing for ${Math.round(orderAge / 1000)}s — marking failed`);
          await pendingOrders.updateStatus(activeOrder.orderId, 'failed', {
            error: 'Order timed out (server may have restarted during processing)',
          });
        } else {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `You have an order being processed right now. Please wait for it to complete before placing a new one.`,
          });
          console.log(`[Timing] Total message handling: ${Date.now() - msgStart}ms`);
          return;
        }
      }

      try {
        const { total, serviceFee } = calculateTotalPayment(orderData.productAmount);

        const orderId = generateOrderId();
        const order: PendingOrder = {
          orderId,
          telegramId: userId,
          chatId,
          action: orderData.action,
          description: orderData.description,
          productAmount: orderData.productAmount,
          serviceFee,
          totalAmount: total,
          toolName: orderData.toolName,
          toolArgs: orderData.toolArgs,
          status: 'pending_confirmation',
          createdAt: Date.now(),
          expiresAt: Date.now() + 10 * 60 * 1000,
        };

        await pendingOrders.create(order);

        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `📋 Order Summary\n\n` +
            `${orderData.description}\n\n` +
            `Amount: ${orderData.productAmount.toFixed(2)} ${TOKEN_SYMBOL}\n` +
            `Service Fee (1.5%): ${serviceFee.toFixed(2)} ${TOKEN_SYMBOL}\n` +
            `Total: ${total.toFixed(2)} ${TOKEN_SYMBOL}\n\n` +
            `Your Balance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\n\n` +
            `Expires in 10 minutes`,
          reply_markup: { inline_keyboard: [
            [{ text: '✅ Confirm Order', callback_data: `order_confirm_${orderId}` }],
            [{ text: '❌ Cancel', callback_data: `order_cancel_${orderId}` }],
          ]},
        });
      } catch {
        await sendLongMessage(chatId, stripMarkdown(response));
      }
    } else {
      await sendLongMessage(chatId, stripMarkdown(response));
    }
    console.log(`[Timing] Total message handling: ${Date.now() - msgStart}ms`);
  } catch (error: any) {
    console.error('[Telegram Bot Error]', { userId, error: error.message, type: error.name });

    if (error.message.includes('malicious') || error.message.includes('too long')) {
      await tg('sendMessage', { chat_id: chatId, text: error.message });
    } else if (error.message.includes('INSUFFICIENT_BALANCE') || error.message.includes('Insufficient balance')) {
      await tg('sendMessage', { chat_id: chatId, text: 'Unable to complete request. Please try again later or contact support.' });
    } else {
      await tg('sendMessage', { chat_id: chatId, text: 'An error occurred processing your request. Please try again.' });
    }
  } finally {
    userMessageLock.delete(userId);
  }
}

// ─────────────────────────────────────────────────
// Group Commands
// ─────────────────────────────────────────────────

async function cmdGroup(chatId: number, userId: string, text: string, groupId: string | null) {
  if (!groupId) {
    await tg('sendMessage', { chat_id: chatId, text: 'This command only works in group chats. Add me to a group first!' });
    return;
  }

  const subCmd = text.split(/\s+/)[1]?.toLowerCase();

  // /group enable — create group wallet
  if (subCmd === 'enable') {
    const existing = await getGroup(groupId);
    if (existing) {
      const { balance } = await getGroupBalance(existing, walletManager);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `Group wallet already enabled!\n\nAddress: ${existing.walletAddress}\nBalance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\nAdmin: set up by user ${existing.adminUserId}`,
      });
      return;
    }

    // Verify the user is a group admin before allowing wallet creation
    try {
      const member = await tg<{ status: string }>('getChatMember', { chat_id: chatId, user_id: parseInt(userId) });
      if (member.status !== 'creator' && member.status !== 'administrator') {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'Only group admins can enable the group wallet. Ask a group admin to run /group enable.',
        });
        return;
      }
    } catch {
      // If we can't check, proceed (backward compat)
    }

    // Get group name from Telegram
    let groupName = 'Group';
    try {
      const chat = await tg<{ title?: string }>('getChat', { chat_id: chatId });
      groupName = chat.title || 'Group';
    } catch { /* use default */ }

    const group = await enableGroup(groupId, 'telegram', groupName, userId, walletManager);
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `Group wallet enabled!\n\n` +
        `Group: ${groupName}\n` +
        `Wallet: ${group.walletAddress}\n` +
        `Admin: you\n\n` +
        `Members can /contribute cUSD to the group wallet.\n` +
        `Admin can /group_withdraw to external addresses.\n` +
        `Spending requires ${Math.round(group.pollThreshold * 100)}% poll approval.`,
    });
    return;
  }

  // /group — show group info
  const group = await getGroup(groupId);
  if (!group) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'No group wallet set up yet. An admin can run /group enable to create one.',
    });
    return;
  }

  const { balance } = await getGroupBalance(group, walletManager);
  const contributions = await getMemberContributions(groupId);
  const recentTxs = await getGroupTransactions(groupId, 5);

  const pollStatus = (group.pollingEnabled ?? true) ? 'ON' : 'OFF';
  const thresholdPct = Math.round((group.pollThreshold ?? 0.7) * 100);
  let text2 =
    `👥 ${group.name} — Group Wallet\n\n` +
    `Address: ${group.walletAddress}\n` +
    `Balance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\n` +
    `Members: ${group.members.length}\n` +
    `Poll Threshold: ${thresholdPct}%\n` +
    `Polling: ${pollStatus}\n`;

  if (contributions.length > 0) {
    text2 += `\nContributions:\n`;
    for (const c of contributions.slice(0, 10)) {
      text2 += `  User ${c.userId}: ${c.total.toFixed(2)} ${TOKEN_SYMBOL}\n`;
    }
  }

  if (recentTxs.length > 0) {
    text2 += `\nRecent Activity:\n`;
    for (const tx of recentTxs) {
      const date = tx.createdAt.toLocaleDateString();
      text2 += `  ${date} | ${tx.type} | ${tx.amount.toFixed(2)} ${TOKEN_SYMBOL}\n`;
    }
  }

  await tg('sendMessage', { chat_id: chatId, text: text2 });
}

async function cmdContribute(chatId: number, userId: string, text: string, groupId: string | null) {
  if (!groupId) {
    await tg('sendMessage', { chat_id: chatId, text: 'This command only works in group chats.' });
    return;
  }

  const group = await getGroup(groupId);
  if (!group) {
    await tg('sendMessage', { chat_id: chatId, text: 'No group wallet set up. An admin can run /group enable first.' });
    return;
  }

  const parts = text.split(/\s+/);
  const amount = parseFloat(parts[1]);
  if (!amount || !isFinite(amount) || amount <= 0) {
    await tg('sendMessage', { chat_id: chatId, text: `Usage: /contribute <amount>\nExample: /contribute 5.00` });
    return;
  }

  try {
    await tg('sendMessage', { chat_id: chatId, text: `Contributing ${amount.toFixed(2)} ${TOKEN_SYMBOL} to group wallet...` });
    const result = await contributeToGroup(group, userId, amount, walletManager);
    const { balance } = await getGroupBalance(group, walletManager);
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `Contribution complete!\n\n` +
        `Amount: ${amount.toFixed(2)} ${TOKEN_SYMBOL}\n` +
        `Group balance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\n` +
        `TX: ${EXPLORER_BASE}/tx/${result.txHash}`,
    });
  } catch (err: any) {
    await tg('sendMessage', { chat_id: chatId, text: `Contribution failed: ${err.message}` });
  }
}

async function cmdGroupWithdraw(chatId: number, userId: string, text: string, groupId: string | null) {
  if (!groupId) {
    await tg('sendMessage', { chat_id: chatId, text: 'This command only works in group chats.' });
    return;
  }

  const group = await getGroup(groupId);
  if (!group) {
    await tg('sendMessage', { chat_id: chatId, text: 'No group wallet set up.' });
    return;
  }

  if (!isGroupAdmin(group, userId)) {
    await tg('sendMessage', { chat_id: chatId, text: 'Only the group admin can withdraw from the group wallet.' });
    return;
  }

  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    await tg('sendMessage', { chat_id: chatId, text: `Usage: /group_withdraw <celo_address> <amount>\nExample: /group_withdraw 0x1234...abcd 10.00` });
    return;
  }

  const toAddress = parts[1];
  const amount = parseFloat(parts[2]);

  if (!isAddress(toAddress)) {
    await tg('sendMessage', { chat_id: chatId, text: 'Invalid Celo address.' });
    return;
  }
  if (!amount || !isFinite(amount) || amount <= 0) {
    await tg('sendMessage', { chat_id: chatId, text: 'Invalid amount.' });
    return;
  }

  try {
    await tg('sendMessage', { chat_id: chatId, text: `Withdrawing ${amount.toFixed(2)} ${TOKEN_SYMBOL} from group wallet...` });
    const result = await groupWithdraw(group, amount, toAddress, walletManager);
    const { balance } = await getGroupBalance(group, walletManager);
    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `Group withdrawal complete!\n\n` +
        `Amount: ${amount.toFixed(2)} ${TOKEN_SYMBOL}\n` +
        `To: ${toAddress}\n` +
        `Group balance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\n` +
        `TX: ${EXPLORER_BASE}/tx/${result.txHash}`,
    });
  } catch (err: any) {
    await tg('sendMessage', { chat_id: chatId, text: `Group withdrawal failed: ${err.message}` });
  }
}

// ─────────────────────────────────────────────────
// Poll System
// ─────────────────────────────────────────────────

/**
 * Create a Telegram poll for a group spending decision.
 * Sends a non-anonymous poll, pins it, and stores tracking info.
 */
export async function sendGroupPoll(params: {
  chatId: number;
  groupId: string;
  createdBy: string;
  description: string;
  service: string;
  amount: number;
  details: Record<string, any>;
}): Promise<{ pollId: string }> {
  const group = await getGroup(params.groupId);
  if (!group) throw new Error('No group wallet set up.');

  const poll = await createGroupPoll({
    groupId: params.groupId,
    chatId: params.chatId,
    createdBy: params.createdBy,
    description: params.description,
    service: params.service,
    amount: params.amount,
    details: params.details,
    threshold: group.pollThreshold ?? 0.7,
    totalMembers: group.members.length,
  });

  const thresholdPct = Math.round((group.pollThreshold ?? 0.7) * 100);

  // Send Telegram native poll (non-anonymous so we track who voted)
  const pollMsg = await tg<{ message_id: number; poll: { id: string } }>('sendPoll', {
    chat_id: params.chatId,
    question: `Spend ${params.amount.toFixed(2)} cUSD? ${params.description}`,
    options: ['Yes', 'No'],
    is_anonymous: false,
    allows_multiple_answers: false,
  });

  // Store message ID and TG poll ID for tracking
  await setPollMessageInfo(poll.pollId, pollMsg.message_id, pollMsg.poll.id);

  // Pin the poll
  tgSilent('pinChatMessage', {
    chat_id: params.chatId,
    message_id: pollMsg.message_id,
    disable_notification: true,
  });

  // Send context message
  await tg('sendMessage', {
    chat_id: params.chatId,
    text:
      `Poll created! ${thresholdPct}% approval needed (${Math.ceil(group.members.length * (group.pollThreshold ?? 0.7))} of ${group.members.length} members).\n\n` +
      `Vote above to approve or reject this group spend.\n` +
      `Poll expires in 24 hours.`,
  });

  return { pollId: poll.pollId };
}

/**
 * Handle Telegram poll_answer updates — track votes and auto-execute on threshold.
 */
async function handlePollAnswer(pollAnswer: { poll_id: string; user: { id: number }; option_ids: number[] }): Promise<void> {
  const tgPollId = pollAnswer.poll_id;
  const userId = pollAnswer.user.id.toString();
  const optionIds = pollAnswer.option_ids;

  // Find our poll by TG poll ID
  const poll = await getPollByTgPollId(tgPollId);
  if (!poll) return; // Not one of our polls

  // option 0 = Yes, option 1 = No, empty = retracted vote
  if (optionIds.length === 0) return; // Vote retracted — ignore
  const vote = optionIds[0] === 0 ? 'yes' : 'no';

  const result = await recordPollVote(poll.pollId, userId, vote);
  if (!result) return;

  if (result.status === 'approved') {
    // Unpin the poll
    if (poll.messageId) {
      tgSilent('unpinChatMessage', { chat_id: poll.chatId, message_id: poll.messageId });
    }
    // Stop the poll
    if (poll.messageId) {
      tgSilent('stopPoll', { chat_id: poll.chatId, message_id: poll.messageId });
    }

    await tg('sendMessage', {
      chat_id: poll.chatId,
      text:
        `Poll approved! ${result.yesCount}/${result.totalMembers} voted yes (${Math.round(result.threshold * 100)}% needed).\n\n` +
        `Executing: ${poll.description}\n` +
        `Amount: ${poll.action.amount.toFixed(2)} cUSD from group wallet.`,
    });

    // Execute the approved action via the order confirmation flow
    // We create a pending order from the group wallet
    try {
      const group = await getGroup(poll.groupId);
      if (!group) throw new Error('Group not found');

      const { total, serviceFee } = calculateTotalPayment(poll.action.amount);
      const orderId = generateOrderId();
      const order: PendingOrder = {
        orderId,
        telegramId: group.walletId, // Use group wallet as payer
        chatId: poll.chatId,
        action: poll.action.service.replace('send_', '').replace('pay_', '').replace('buy_', '') as any,
        description: `[Group Poll] ${poll.description}`,
        productAmount: poll.action.amount,
        serviceFee,
        totalAmount: total,
        toolName: poll.action.service,
        toolArgs: poll.action.details,
        status: 'pending_confirmation',
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
      };

      await pendingOrders.create(order);

      await tg('sendMessage', {
        chat_id: poll.chatId,
        text:
          `Total: ${total.toFixed(2)} cUSD (includes 1.5% fee)\n\n` +
          `Admin — confirm to execute from group wallet:`,
        reply_markup: { inline_keyboard: [
          [{ text: 'Confirm Group Spend', callback_data: `order_confirm_${orderId}` }],
          [{ text: 'Cancel', callback_data: `order_cancel_${orderId}` }],
        ]},
      });
    } catch (err: any) {
      await tg('sendMessage', { chat_id: poll.chatId, text: `Poll approved but failed to create order: ${err.message}` });
    }
  } else if (result.status === 'rejected') {
    // Unpin and stop the poll
    if (poll.messageId) {
      tgSilent('unpinChatMessage', { chat_id: poll.chatId, message_id: poll.messageId });
      tgSilent('stopPoll', { chat_id: poll.chatId, message_id: poll.messageId });
    }

    await tg('sendMessage', {
      chat_id: poll.chatId,
      text: `Poll rejected. Too many "No" votes — threshold of ${Math.round(result.threshold * 100)}% can no longer be reached.`,
    });
  }
}

async function cmdGroupThreshold(chatId: number, userId: string, text: string, groupId: string | null) {
  if (!groupId) {
    await tg('sendMessage', { chat_id: chatId, text: 'This command only works in group chats.' });
    return;
  }

  const group = await getGroup(groupId);
  if (!group) {
    await tg('sendMessage', { chat_id: chatId, text: 'No group wallet set up. Run /group enable first.' });
    return;
  }

  if (!isGroupAdmin(group, userId)) {
    await tg('sendMessage', { chat_id: chatId, text: 'Only the group admin can change the poll threshold.' });
    return;
  }

  const parts = text.split(/\s+/);
  const pct = parseFloat(parts[1]);
  if (!pct || pct < 10 || pct > 100) {
    const current = Math.round((group.pollThreshold ?? 0.7) * 100);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Current poll threshold: ${current}%\n\nUsage: /threshold <10-100>\nExample: /threshold 70 (70% approval needed)`,
    });
    return;
  }

  await setPollThreshold(groupId, pct / 100);
  await tg('sendMessage', {
    chat_id: chatId,
    text: `Poll threshold updated to ${pct}%. Group spending decisions now require ${pct}% approval.`,
  });
}

// ─────────────────────────────────────────────────
// Admin Commands (Poll Management, Task Management)
// ─────────────────────────────────────────────────

async function cmdPoll(chatId: number, userId: string, text: string, groupId: string | null) {
  if (!groupId) {
    await tg('sendMessage', { chat_id: chatId, text: 'This command only works in group chats.' });
    return;
  }
  const group = await getGroup(groupId);
  if (!group) {
    await tg('sendMessage', { chat_id: chatId, text: 'No group wallet set up.' });
    return;
  }
  if (!isGroupAdmin(group, userId)) {
    await tg('sendMessage', { chat_id: chatId, text: 'Only the group admin can manage polls.' });
    return;
  }

  const parts = text.split(/\s+/);
  const subCmd = parts[1]?.toLowerCase();
  const pollIdArg = parts[2];

  switch (subCmd) {
    case 'cancel': {
      const targetPollId = pollIdArg || (await getMostRecentActivePoll(groupId))?.pollId;
      if (!targetPollId) {
        await tg('sendMessage', { chat_id: chatId, text: 'No active polls to cancel.' });
        return;
      }
      const closed = await closePoll(targetPollId, 'cancelled');
      const poll = await getPollById(targetPollId);
      if (poll?.messageId) {
        tgSilent('stopPoll', { chat_id: chatId, message_id: poll.messageId });
        tgSilent('unpinChatMessage', { chat_id: chatId, message_id: poll.messageId });
      }
      await tg('sendMessage', { chat_id: chatId, text: closed ? `Poll cancelled.` : 'Poll not found or already closed.' });
      return;
    }
    case 'approve': {
      const targetPollId = pollIdArg || (await getMostRecentActivePoll(groupId))?.pollId;
      if (!targetPollId) {
        await tg('sendMessage', { chat_id: chatId, text: 'No active polls to approve.' });
        return;
      }
      const closed = await closePoll(targetPollId, 'approved');
      const poll = await getPollById(targetPollId);
      if (poll?.messageId) {
        tgSilent('stopPoll', { chat_id: chatId, message_id: poll.messageId });
        tgSilent('unpinChatMessage', { chat_id: chatId, message_id: poll.messageId });
      }
      if (closed && poll) {
        // Execute the approved action via the order confirmation flow
        try {
          const { total, serviceFee } = calculateTotalPayment(poll.action.amount);
          const orderId = generateOrderId();
          const order: PendingOrder = {
            orderId,
            telegramId: group.walletId,
            chatId: poll.chatId,
            action: poll.action.service.replace('send_', '').replace('pay_', '').replace('buy_', '') as any,
            description: `[Admin Approved] ${poll.description}`,
            productAmount: poll.action.amount,
            serviceFee,
            totalAmount: total,
            toolName: poll.action.service,
            toolArgs: poll.action.details,
            status: 'pending_confirmation',
            createdAt: Date.now(),
            expiresAt: Date.now() + 10 * 60 * 1000,
          };
          await pendingOrders.create(order);
          await tg('sendMessage', {
            chat_id: chatId,
            text: `Admin approved: ${poll.description}\nTotal: ${total.toFixed(2)} cUSD (includes 1.5% fee)\n\nConfirm to execute from group wallet:`,
            reply_markup: { inline_keyboard: [
              [{ text: 'Confirm Group Spend', callback_data: `order_confirm_${orderId}` }],
              [{ text: 'Cancel', callback_data: `order_cancel_${orderId}` }],
            ]},
          });
        } catch (err: any) {
          await tg('sendMessage', { chat_id: chatId, text: `Poll approved but failed to create order: ${err.message}` });
        }
      } else {
        await tg('sendMessage', { chat_id: chatId, text: 'Poll not found or already closed.' });
      }
      return;
    }
    case 'off': {
      await setPollingEnabled(groupId, false);
      await tg('sendMessage', { chat_id: chatId, text: 'Polling disabled. All group members can now spend directly without polls.' });
      return;
    }
    case 'on': {
      await setPollingEnabled(groupId, true);
      await tg('sendMessage', { chat_id: chatId, text: 'Polling re-enabled. Non-admin spending requests will go to a poll vote.' });
      return;
    }
    default: {
      const active = await getActivePolls(groupId);
      const pollStatus = (group.pollingEnabled ?? true) ? 'ON' : 'OFF';
      if (active.length === 0) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: `No active polls. Polling is ${pollStatus}.\n\nCommands:\n/poll cancel [poll_id]\n/poll approve [poll_id]\n/poll off — disable polling\n/poll on — enable polling`,
        });
      } else {
        let list = `Active Polls (${active.length}) — Polling: ${pollStatus}\n\n`;
        for (const p of active) {
          list += `${p.pollId}\n${p.description}\n${p.action.amount.toFixed(2)} cUSD | ${p.yesVotes.length} yes / ${p.noVotes.length} no\n\n`;
        }
        list += 'Commands: /poll cancel [id], /poll approve [id]';
        await tg('sendMessage', { chat_id: chatId, text: list });
      }
      return;
    }
  }
}

async function cmdTasks(chatId: number, userId: string, groupId: string | null) {
  if (!groupId) {
    await tg('sendMessage', { chat_id: chatId, text: 'This command only works in group chats.' });
    return;
  }
  const group = await getGroup(groupId);
  if (!group || !isGroupAdmin(group, userId)) {
    await tg('sendMessage', { chat_id: chatId, text: 'Admin only.' });
    return;
  }

  const [scheduled, recurring] = await Promise.all([
    getScheduledTasksByChatId(chatId),
    getRecurringTasksByChatId(chatId),
  ]);

  if (scheduled.length === 0 && recurring.length === 0) {
    await tg('sendMessage', { chat_id: chatId, text: 'No scheduled or recurring tasks for this group.' });
    return;
  }

  let msg = '';
  if (scheduled.length > 0) {
    msg += `Scheduled Tasks (${scheduled.length}):\n`;
    for (const t of scheduled) {
      msg += `${t._id} | ${t.description} | ${new Date(t.scheduledAt).toLocaleString()}\n`;
    }
    msg += '\n';
  }
  if (recurring.length > 0) {
    msg += `Recurring Tasks (${recurring.length}):\n`;
    for (const t of recurring) {
      msg += `${t._id} | ${t.description} | ${t.recurrence.frequency} at ${t.recurrence.time}\n`;
    }
  }
  msg += '\nCancel: /task cancel <id>';
  await tg('sendMessage', { chat_id: chatId, text: msg });
}

async function cmdTaskCancel(chatId: number, userId: string, text: string, groupId: string | null) {
  if (!groupId) {
    await tg('sendMessage', { chat_id: chatId, text: 'This command only works in group chats.' });
    return;
  }
  const group = await getGroup(groupId);
  if (!group || !isGroupAdmin(group, userId)) {
    await tg('sendMessage', { chat_id: chatId, text: 'Admin only.' });
    return;
  }

  const taskId = text.split(/\s+/)[2];
  if (!taskId) {
    await tg('sendMessage', { chat_id: chatId, text: 'Usage: /task cancel <task_id>' });
    return;
  }

  const cancelledScheduled = await adminCancelScheduledTask(taskId);
  const cancelledRecurring = !cancelledScheduled ? await adminCancelRecurringTask(taskId) : false;

  if (cancelledScheduled || cancelledRecurring) {
    await tg('sendMessage', { chat_id: chatId, text: `Task ${taskId} cancelled.` });
  } else {
    await tg('sendMessage', { chat_id: chatId, text: 'Task not found or already cancelled/completed.' });
  }
}

// ─────────────────────────────────────────────────
// Update Router
// ─────────────────────────────────────────────────

async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    // Auto-create wallet for every user interaction (fire-and-forget — don't block message handling).
    // Wallets are created on /start; this is defense-in-depth for edge cases.
    // handleTextMessage fetches balance anyway, which verifies wallet existence.
    const from = update.message?.from || update.callback_query?.from;
    if (from?.id) {
      walletManager.getOrCreateWallet(from.id.toString()).catch(() => {});
      // Infer timezone from Telegram language_code (no-op if already set)
      if (from.language_code) {
        userSettingsStore.inferFromLanguageCode(from.id.toString(), from.language_code).catch(() => {});
      }
    }

    // Poll answer (someone voted on a group poll)
    if (update.poll_answer) {
      await handlePollAnswer(update.poll_answer);
      return;
    }

    // Callback query (inline button press)
    if (update.callback_query) {
      await handleCallback(update.callback_query, walletManager, pendingOrders, recordSpending);
      return;
    }

    // Text message
    const text = update.message?.text;
    if (update.message && text) {
      const chatId = update.message.chat.id;
      if (!update.message.from?.id) return; // No user ID (channel posts, etc.)
      const userId = update.message.from.id.toString();

      const chatType = update.message.chat.type;
      const isGroupChat = chatType === 'group' || chatType === 'supergroup';
      const groupId = isGroupChat ? chatId.toString() : null;

      // In groups: always record message history for context
      if (isGroupChat && groupId) {
        recordGroupMsg(groupId, userId, text);
      }

      // Commands always work in groups (Telegram shows per-bot command menus)
      if (text.startsWith('/')) {
        const cmd = text.split(' ')[0].replace('/', '').split('@')[0];

        switch (cmd) {
          case 'start': return cmdStart(chatId, userId);
          case 'wallet': return cmdWallet(chatId, userId, groupId);
          case 'withdraw': return cmdWithdraw(chatId, userId, text);
          case 'help': return cmdHelp(chatId, isGroupChat);
          case 'rate': return cmdRate(chatId, text);
          case 'settings': return cmdSettings(chatId, userId, chatType);
          case 'history': return cmdHistory(chatId);
          case 'cancel': return cmdCancel(chatId, userId);
          case 'clear': return cmdClear(chatId, userId);
          case 'silent': return cmdSilent(chatId, userId);
          case 'status': return cmdStatus(chatId, userId);
          case 'export': return cmdExport(chatId);
          case 'verify': return cmdVerify(chatId, userId);
          // Group commands
          case 'group': return cmdGroup(chatId, userId, text, groupId);
          case 'contribute': return cmdContribute(chatId, userId, text, groupId);
          case 'group_withdraw': return cmdGroupWithdraw(chatId, userId, text, groupId);
          case 'threshold': return cmdGroupThreshold(chatId, userId, text, groupId);
          // Admin commands
          case 'poll': return cmdPoll(chatId, userId, text, groupId);
          case 'tasks': return cmdTasks(chatId, userId, groupId);
          case 'task': return cmdTaskCancel(chatId, userId, text, groupId);
          default: return handleTextMessage(chatId, userId, text, groupId);
        }
      }

      // Free text in groups: only respond if bot is @mentioned or replied to
      if (isGroupChat && !isBotMentioned(update.message)) return;

      // Build context (recent messages + replied-to message) for group chats
      const groupCtx = isGroupChat ? buildTgGroupContext(update.message, groupId!) : '';
      return handleTextMessage(chatId, userId, text, groupId, groupCtx);
    }

    // Voice message
    if (update.message?.voice) {
      const chatId = update.message.chat.id;
      if (!update.message.from?.id) return;
      // In groups, only process voice notes that reply to the bot.
      // Voice messages can't carry @mentions (no text), so reply-to-bot is the only trigger.
      const vChatType = update.message.chat.type;
      if ((vChatType === 'group' || vChatType === 'supergroup') &&
          update.message.reply_to_message?.from?.id !== botId) {
        return;
      }
      const userId = update.message.from.id.toString();
      const { file_id, duration } = update.message.voice;
      return handleVoiceMessage(chatId, userId, file_id, duration);
    }
  } catch (err: any) {
    const uid = update.message?.from?.id || update.callback_query?.from?.id;
    console.error('[Bot Update Error]', { update_id: update.update_id, userId: uid, error: err.message });
  }
}

// ─────────────────────────────────────────────────
// Long-Polling (dev mode)
// ─────────────────────────────────────────────────

let pollingActive = false;

async function startPolling() {
  pollingActive = true;
  let offset = 0;

  while (pollingActive) {
    try {
      const updates = await tg<TgUpdate[]>('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'poll_answer'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        handleUpdate(update).catch(err => console.error('[Polling Update Error]', err.message));
      }
    } catch (err: any) {
      console.error('[Polling Error]', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function stopPolling() { pollingActive = false; }

// ─────────────────────────────────────────────────
// Start Bot
// ─────────────────────────────────────────────────

export async function startTelegramBot(expressApp?: import('express').Express) {
  // Get bot identity for @mention detection in groups
  try {
    const me = await tg<{ id: number; username: string }>('getMe');
    botId = me.id;
    botUsername = me.username || '';
    console.log(`[Telegram] Bot: @${botUsername} (${botId})`);
  } catch (err: any) {
    console.error('[Telegram] Failed to get bot info:', err.message);
  }

  const apiUrl = process.env.API_URL;
  // Use a hash of the token instead of the raw token in the URL path
  // Prevents token leakage in logs, monitoring tools, and server routing tables
  const tokenHash = crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN || '').digest('hex').slice(0, 32);
  const webhookPath = `/bot/webhook/${tokenHash}`;

  // Private chat commands
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Create wallet & get started' },
      { command: 'wallet', description: 'Check balance & deposit address' },
      { command: 'withdraw', description: 'Withdraw cUSD to external wallet' },
      { command: 'rate', description: 'Check FX rate (e.g. /rate NG)' },
      { command: 'status', description: 'Your profile, instructions & tasks' },
      { command: 'settings', description: 'Wallet settings & export key' },
      { command: 'cancel', description: 'Cancel pending order' },
      { command: 'silent', description: 'Toggle proactive messages' },
      { command: 'verify', description: 'Verify identity (unlock $200/day limit)' },
      { command: 'clear', description: 'Clear conversation memory' },
      { command: 'help', description: 'Show help & examples' },
    ],
    scope: { type: 'all_private_chats' },
  });

  // Group chat commands
  await tg('setMyCommands', {
    commands: [
      { command: 'group', description: 'Group wallet info (or /group enable)' },
      { command: 'contribute', description: 'Contribute cUSD to group wallet' },
      { command: 'group_withdraw', description: 'Admin: withdraw from group' },
      { command: 'threshold', description: 'Admin: set poll approval % (e.g. /threshold 70)' },
      { command: 'poll', description: 'Admin: manage polls (cancel/approve/off/on)' },
      { command: 'tasks', description: 'Admin: view group scheduled tasks' },
      { command: 'task', description: 'Admin: cancel a task (/task cancel <id>)' },
      { command: 'wallet', description: 'Check your personal balance' },
      { command: 'help', description: 'Show help & commands' },
    ],
    scope: { type: 'all_group_chats' },
  });

  if (apiUrl && expressApp) {
    const webhookUrl = `${apiUrl}${webhookPath}`;
    await tg('setWebhook', { url: webhookUrl, drop_pending_updates: true, allowed_updates: ['message', 'callback_query', 'poll_answer'] });

    expressApp.post(webhookPath, (req: any, res: any) => {
      // Respond 200 immediately — Telegram retries on timeout (25s) and that
      // causes duplicate processing. Agent calls can take 10-30s easily.
      res.sendStatus(200);
      handleUpdate(req.body).catch(err =>
        console.error('[Webhook Error]', err.message),
      );
    });

    console.log(`Toppa Telegram bot running (webhook: ${apiUrl}/bot/webhook/***)`);
  } else {
    await tg('deleteWebhook', { drop_pending_updates: true });
    startPolling();
    console.log('Toppa Telegram bot running (long-polling mode)');

    process.once('SIGINT', () => { stopPolling(); stopScheduler(); stopHeartbeat(); stopSellOrderPoller(); });
    process.once('SIGTERM', () => { stopPolling(); stopScheduler(); stopHeartbeat(); stopSellOrderPoller(); });
  }

  // Start scheduler (await ensures stuck-task recovery runs before accepting requests)
  await startScheduler(async (task: ScheduledTask) => {
    try {
      const { total, serviceFee } = calculateTotalPayment(task.productAmount);
      const orderId = generateOrderId();
      const order: PendingOrder = {
        orderId,
        telegramId: task.userId,
        chatId: task.chatId,
        action: task.toolName.replace('send_', '').replace('pay_', '').replace('buy_', '') as any,
        description: `[Scheduled] ${task.description}`,
        productAmount: task.productAmount,
        serviceFee,
        totalAmount: total,
        toolName: task.toolName,
        toolArgs: task.toolArgs,
        status: 'pending_confirmation',
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
      };

      await pendingOrders.create(order);

      await tg('sendMessage', {
        chat_id: task.chatId,
        text:
          `⏰ Scheduled Task Ready\n\n` +
          `${task.description}\n\n` +
          `Amount: ${task.productAmount.toFixed(2)} ${TOKEN_SYMBOL}\n` +
          `Service Fee (1.5%): ${serviceFee.toFixed(2)} ${TOKEN_SYMBOL}\n` +
          `Total: ${total.toFixed(2)} ${TOKEN_SYMBOL}\n\n` +
          `This was scheduled earlier. Confirm to proceed.`,
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Confirm & Pay', callback_data: `order_confirm_${orderId}` }],
          [{ text: '❌ Skip', callback_data: `order_cancel_${orderId}` }],
        ]},
      });

      await markTaskCompleted(task._id!, 'Notification sent — awaiting user confirmation');
    } catch (err: any) {
      console.error(`[Scheduler] Failed to notify user for task ${task._id}:`, err.message);
      await markTaskFailed(task._id!, err.message);
    }
  });

  // Start recurring scheduler — reuses the same notification flow as one-time tasks
  await startRecurringScheduler(async (task: ScheduledTask) => {
    try {
      const { total, serviceFee } = calculateTotalPayment(task.productAmount);
      const orderId = generateOrderId();
      const order: PendingOrder = {
        orderId,
        telegramId: task.userId,
        chatId: task.chatId,
        action: task.toolName.replace('send_', '').replace('pay_', '').replace('buy_', '') as any,
        description: `[Recurring] ${task.description}`,
        productAmount: task.productAmount,
        serviceFee,
        totalAmount: total,
        toolName: task.toolName,
        toolArgs: task.toolArgs,
        status: 'pending_confirmation',
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
      };

      await pendingOrders.create(order);

      await tg('sendMessage', {
        chat_id: task.chatId,
        text:
          `🔄 Recurring Payment Ready\n\n` +
          `${task.description}\n\n` +
          `Amount: ${task.productAmount.toFixed(2)} ${TOKEN_SYMBOL}\n` +
          `Service Fee (1.5%): ${serviceFee.toFixed(2)} ${TOKEN_SYMBOL}\n` +
          `Total: ${total.toFixed(2)} ${TOKEN_SYMBOL}\n\n` +
          `This is your recurring payment. Confirm to proceed.`,
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Confirm & Pay', callback_data: `order_confirm_${orderId}` }],
          [{ text: '❌ Skip This Time', callback_data: `order_cancel_${orderId}` }],
        ]},
      });
    } catch (err: any) {
      console.error(`[Scheduler] Failed to notify user for recurring task ${task._id}:`, err.message);
    }
  });

  // Start heartbeat
  startHeartbeat(async (chatId: number, text: string) => {
    await tg('sendMessage', { chat_id: chatId, text: stripMarkdown(text) });
  });

  // Sell order poller disabled — Prestmit integration paused, Cardtonic coming soon
  // startSellOrderPoller(async (_userId: string, chatId: number, message: string) => {
  //   await tg('sendMessage', { chat_id: chatId, text: message });
  // });
}
