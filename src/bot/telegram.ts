import crypto from 'node:crypto';
import { isAddress } from 'viem';
import { tg, tgSilent, TgUpdate } from './tg-client';
import { runToppaAgent } from '../agent/graph';
import { calculateTotalPayment } from '../blockchain/x402';
import { WalletManager } from '../wallet/manager';
import { InMemoryWalletStore } from '../wallet/store';
import { MongoWalletStore } from '../wallet/mongo-store';
import { PendingOrderStore, PendingOrder, generateOrderId } from './pending-orders';
import { handleCallback, storePendingWithdrawal } from './handlers';
import { userSettingsStore } from './user-settings';
import { IS_TESTNET, TOKEN_SYMBOL, EXPLORER_BASE } from '../shared/constants';
import { startScheduler, stopScheduler, markTaskCompleted, markTaskFailed, ScheduledTask, getUserScheduledTasks } from '../agent/scheduler';
import { clearConversationHistory } from '../agent/memory';
import { startHeartbeat, stopHeartbeat } from '../agent/heartbeat';
import { trackActivity, setProactiveEnabled, getUserActivity } from '../agent/user-activity';
import { getUserGoals } from '../agent/goals';
import { getFxRate } from '../apis/reloadly';

// ─────────────────────────────────────────────────
// Wallet & Order Infrastructure
// ─────────────────────────────────────────────────

const walletStore = process.env.MONGODB_URI
  ? new MongoWalletStore()
  : new InMemoryWalletStore();
const walletManager = new WalletManager(walletStore);
const pendingOrders = new PendingOrderStore();

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

interface UserRateLimit {
  requestCount: number;
  lastReset: number;
  totalSpent: number;
  spendingResetDate: number;
}

const userRateLimits = new Map<string, UserRateLimit>();

const RATE_LIMIT_WINDOW = 5 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const DAILY_SPENDING_LIMIT = 50;
const SPENDING_RESET_WINDOW = 24 * 60 * 60 * 1000;

let _spendingIndexCreated = false;
async function loadSpendingFromDb(userId: string): Promise<{ totalSpent: number; spendingResetDate: number }> {
  try {
    const { getDb } = await import('../wallet/mongo-store');
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
  import('../wallet/mongo-store').then(({ getDb }) =>
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
    return { allowed: false, reason: 'Too many requests. Please wait 5 minutes.' };
  }

  if (now - userLimit.spendingResetDate > SPENDING_RESET_WINDOW) {
    userLimit.totalSpent = 0;
    userLimit.spendingResetDate = now;
    persistSpendingToDb(userId, 0, now);
  }

  if (userLimit.totalSpent >= DAILY_SPENDING_LIMIT) {
    return { allowed: false, reason: `Daily spending limit of $${DAILY_SPENDING_LIMIT} reached. Try again tomorrow.` };
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

async function cmdWallet(chatId: number, userId: string) {
  try {
    const { balance, address } = await walletManager.getBalance(userId);
    const explorerUrl = `${EXPLORER_BASE}/address/${address}`;

    await tg('sendMessage', {
      chat_id: chatId,
      text:
        `💰 Your Toppa Wallet\n\n` +
        `Address:\n\`${address}\`\n\n` +
        `Balance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\n` +
        `Network: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}\n\n` +
        `Tap address above to copy, then deposit ${TOKEN_SYMBOL} to fund your wallet.`,
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

async function cmdHelp(chatId: number) {
  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `Toppa Commands\n\n` +
      `/start - Create your wallet & get started\n` +
      `/wallet - Check balance & deposit address\n` +
      `/withdraw <address> <amount> - Withdraw ${TOKEN_SYMBOL}\n` +
      `/rate <country> - Check FX rate (e.g. /rate NG)\n` +
      `/settings - Wallet settings & export key\n` +
      `/status - Your profile, instructions & tasks\n` +
      `/silent - Toggle proactive messages on/off\n` +
      `/clear - Clear conversation memory\n` +
      `/cancel - Cancel pending order\n` +
      `/help - Show this help message\n\n` +
      `Just tell me what you need:\n` +
      `• "Send $5 airtime to +234... in Nigeria"\n` +
      `• "Buy a $25 Steam gift card"\n` +
      `• "Pay my DStv bill for 1234567"\n` +
      `• "Send airtime to my brother at 5pm"\n` +
      `• "Remember my sister's number is +234..."\n\n` +
      `I support 170+ countries, 800+ operators, and 300+ gift card brands!`,
  });
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
// Text Message Handler (AI Agent + Order Detection)
// ─────────────────────────────────────────────────

async function handleTextMessage(chatId: number, userId: string, userMessage: string) {
  const msgStart = Date.now();
  trackActivity(userId, chatId).catch(() => {});

  try {
    const rateLimitCheck = await checkRateLimit(userId);
    if (!rateLimitCheck.allowed) {
      await tg('sendMessage', { chat_id: chatId, text: rateLimitCheck.reason! });
      return;
    }

    const sanitizedMessage = sanitizeTelegramInput(userMessage);
    tgSilent('sendChatAction', { chat_id: chatId, action: 'typing' });

    // Refresh typing indicator every 4s (Telegram expires it after ~5s)
    const typingInterval = setInterval(() => {
      tgSilent('sendChatAction', { chat_id: chatId, action: 'typing' });
    }, 4000);

    const balanceStart = Date.now();
    const { balance, address } = await walletManager.getBalance(userId);
    console.log(`[Timing] Balance fetch: ${Date.now() - balanceStart}ms`);

    // Streaming: accumulate LLM text chunks and push native drafts to Telegram
    const draftId = Math.floor(Math.random() * 2147483647) + 1;
    let streamedText = '';
    let lastDraftText = '';

    const draftInterval = setInterval(() => {
      if (streamedText.length > 0 && streamedText !== lastDraftText) {
        lastDraftText = streamedText;
        // Telegram caps messages at 4096 chars — truncate draft to avoid silent failures
        const draftText = stripMarkdown(streamedText).slice(0, 4096);
        tgSilent('sendMessageDraft', { chat_id: chatId, draft_id: draftId, text: draftText });
      }
    }, 300);

    const onStream = (chunk: string) => { streamedText += chunk; };

    let response: string;
    try {
      const result = await runToppaAgent(sanitizedMessage, {
        userAddress: userId,
        source: 'telegram',
        rateLimited: true,
        walletAddress: address,
        walletBalance: balance,
        chatId,
      } as any, { onStream });
      response = result.response;
    } finally {
      clearInterval(draftInterval);
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

    if (orderData) {
      // Block new orders while another is processing (payment in-flight / service executing).
      // The wallet lock would catch this at pay_accept time anyway, but warning early is better UX.
      // Staleness guard: if a processing order is >3 min old, the server likely crashed mid-execution.
      // The in-memory wallet lock resets on restart, but the MongoDB order stays stuck.
      // Mark it failed and let the user continue rather than blocking them indefinitely.
      const STALE_PROCESSING_MS = 3 * 60 * 1000;
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
    const fromId = update.message?.from?.id || update.callback_query?.from?.id;
    if (fromId) walletManager.getOrCreateWallet(fromId.toString()).catch(() => {});

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

      if (text.startsWith('/')) {
        const cmd = text.split(' ')[0].replace('/', '').split('@')[0];

        switch (cmd) {
          case 'start': return cmdStart(chatId, userId);
          case 'wallet': return cmdWallet(chatId, userId);
          case 'withdraw': return cmdWithdraw(chatId, userId, text);
          case 'help': return cmdHelp(chatId);
          case 'rate': return cmdRate(chatId, text);
          case 'settings': return cmdSettings(chatId, userId, update.message.chat.type);
          case 'history': return cmdHistory(chatId);
          case 'cancel': return cmdCancel(chatId, userId);
          case 'clear': return cmdClear(chatId, userId);
          case 'silent': return cmdSilent(chatId, userId);
          case 'status': return cmdStatus(chatId, userId);
          case 'export': return cmdExport(chatId);
          default: return handleTextMessage(chatId, userId, text);
        }
      }

      return handleTextMessage(chatId, userId, text);
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
      const updates = await tg<TgUpdate[]>('getUpdates', { offset, timeout: 30 });
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
  const apiUrl = process.env.API_URL;
  // Use a hash of the token instead of the raw token in the URL path
  // Prevents token leakage in logs, monitoring tools, and server routing tables
  const tokenHash = crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN || '').digest('hex').slice(0, 32);
  const webhookPath = `/bot/webhook/${tokenHash}`;

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
      { command: 'clear', description: 'Clear conversation memory' },
      { command: 'help', description: 'Show help & examples' },
    ],
  });

  if (apiUrl && expressApp) {
    const webhookUrl = `${apiUrl}${webhookPath}`;
    await tg('setWebhook', { url: webhookUrl, drop_pending_updates: true });

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

    process.once('SIGINT', () => { stopPolling(); stopScheduler(); stopHeartbeat(); });
    process.once('SIGTERM', () => { stopPolling(); stopScheduler(); stopHeartbeat(); });
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

  // Start heartbeat
  startHeartbeat(async (chatId: number, text: string) => {
    await tg('sendMessage', { chat_id: chatId, text: stripMarkdown(text) });
  });
}
