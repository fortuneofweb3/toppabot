import { Telegraf, Markup } from 'telegraf';
import { runToppaAgent } from '../agent/graph';
import { calculateTotalPayment } from '../blockchain/x402';
import { WalletManager } from '../wallet/manager';
import { InMemoryWalletStore } from '../wallet/store';
import { MongoWalletStore } from '../wallet/mongo-store';
import { PendingOrderStore, PendingOrder, generateOrderId } from './pending-orders';
import { registerHandlers } from './handlers';
import { userSettingsStore } from './user-settings';
import { IS_TESTNET, TOKEN_SYMBOL, EXPLORER_BASE } from '../shared/constants';
import { startScheduler, stopScheduler, markTaskCompleted, markTaskFailed, ScheduledTask, getUserScheduledTasks } from '../agent/scheduler';
import { clearConversationHistory } from '../agent/memory';
import { startHeartbeat, stopHeartbeat } from '../agent/heartbeat';
import { trackActivity, setProactiveEnabled, getUserActivity } from '../agent/user-activity';
import { getUserGoals } from '../agent/goals';
import { getFxRate } from '../apis/reloadly';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

// ─────────────────────────────────────────────────
// Wallet & Order Infrastructure
// ─────────────────────────────────────────────────

// Use MongoDB if configured, fall back to in-memory
const walletStore = process.env.MONGODB_URI
  ? new MongoWalletStore()
  : new InMemoryWalletStore();
const walletManager = new WalletManager(walletStore);
const pendingOrders = new PendingOrderStore();

// Cleanup stale rate limit entries every 5 minutes (orders auto-expire via MongoDB TTL)
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

// Persist daily spending to MongoDB so it survives restarts
async function loadSpendingFromDb(userId: string): Promise<{ totalSpent: number; spendingResetDate: number }> {
  try {
    const { getDb } = await import('../wallet/mongo-store');
    const db = await getDb();
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
    // Load spending from DB on first request (survives restart)
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
  const userLimit = userRateLimits.get(userId);
  if (userLimit) {
    userLimit.totalSpent += amount;
    // Persist to DB so spending limit survives server restarts
    persistSpendingToDb(userId, userLimit.totalSpent, userLimit.spendingResetDate);
  }
}

// ─────────────────────────────────────────────────
// Security: Input Sanitization
// ─────────────────────────────────────────────────

function sanitizeTelegramInput(input: string): string {
  const dangerous = [
    'ignore previous', 'ignore all', 'new instructions', 'forget everything',
    'system:', 'admin:', 'sudo', 'root:', '```', '<script>', '<|im_end|>',
    'disregard', 'override', 'jailbreak', 'developer mode',
  ];

  for (const phrase of dangerous) {
    if (new RegExp(phrase, 'gi').test(input)) {
      throw new Error('Message contains potentially malicious content. Please rephrase.');
    }
  }

  if (input.length > 500) {
    throw new Error('Message too long. Please keep it under 500 characters.');
  }

  return input;
}

// ─────────────────────────────────────────────────
// Register Inline Keyboard Handlers
// ─────────────────────────────────────────────────

registerHandlers(bot, walletManager, pendingOrders, recordSpending);

// ─────────────────────────────────────────────────
// Middleware: Auto-create wallet on first interaction
// ─────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (ctx.from) {
    await walletManager.getOrCreateWallet(ctx.from.id.toString());
  }
  return next();
});

// ─────────────────────────────────────────────────
// Bot Commands
// ─────────────────────────────────────────────────

/**
 * /start — Welcome + wallet info
 */
bot.command('start', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { address } = await walletManager.getOrCreateWallet(userId);

  const tokenSymbol = TOKEN_SYMBOL;
  const explorerUrl = `${EXPLORER_BASE}/address/${address}`;

  await ctx.reply(
    `Welcome to Toppa!\n\n` +
    `Your Celo wallet:\n\`${address}\`\n\n` +
    `Network: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}\n` +
    `Token: ${tokenSymbol}\n\n` +
    `Deposit ${tokenSymbol} on Celo to get started.\n` +
    `Other tokens sent here won't show in-app, but you can recover them via /settings.\n\n` +
    `Just tell me what you need in plain English!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
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
        ]
      }
    }
  );
});

/**
 * /wallet — Show balance and address
 */
bot.command('wallet', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const { balance, address } = await walletManager.getBalance(userId);
    const tokenSymbol = TOKEN_SYMBOL;
    const explorerUrl = `${EXPLORER_BASE}/address/${address}`;

    await ctx.reply(
      `💰 Your Toppa Wallet\n\n` +
      `Address:\n\`${address}\`\n\n` +
      `Balance: ${balance} ${tokenSymbol}\n` +
      `Network: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}\n\n` +
      `Tap address above to copy, then deposit ${tokenSymbol} to fund your wallet.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 View on Celoscan', url: explorerUrl }],
            [{ text: '🔄 Refresh Balance', callback_data: `balance_${userId}` }],
          ]
        }
      }
    );
  } catch (error: any) {
    await ctx.reply(`❌ Error: ${error.message}`);
  }
});

/**
 * /withdraw — Withdraw cUSD to external address
 */
bot.command('withdraw', async (ctx) => {
  const userId = ctx.from.id.toString();
  const parts = ctx.message.text.split(' ');

  if (parts.length < 3) {
    await ctx.reply(
      `Usage: /withdraw <celo_address> <amount>\n` +
      `Example: /withdraw 0x1234...abcd 10.00`,
    );
    return;
  }

  const toAddress = parts[1];
  const amount = parseFloat(parts[2]);

  if (!toAddress.startsWith('0x') || toAddress.length !== 42 || !/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
    await ctx.reply(
      `❌ Invalid Address\n\n` +
      `Celo addresses must:\n` +
      `• Start with 0x\n` +
      `• Be exactly 42 characters\n` +
      `• Contain only 0-9 and a-f\n\n` +
      `Example:\n\`0x1234567890abcdef1234567890abcdef12345678\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  if (isNaN(amount) || !isFinite(amount) || amount <= 0 || amount > 10000) {
    await ctx.reply(
      `❌ Invalid Amount\n\n` +
      `Amount must be a positive number.\n` +
      `Example: /withdraw ${toAddress.slice(0, 10)}... 10.5`
    );
    return;
  }

  await ctx.reply(
    `Withdraw ${amount} cUSD to\n${toAddress}?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Confirm Withdrawal', `withdraw_confirm_${userId}_${amount}_${toAddress}`)],
      [Markup.button.callback('Cancel', `withdraw_cancel_${userId}`)],
    ]),
  );
});

/**
 * /help — Show available commands and examples
 */
bot.command('help', async (ctx) => {
  await ctx.reply(
    `Toppa Commands\n\n` +
    `/start - Create your wallet & get started\n` +
    `/wallet - Check balance & deposit address\n` +
    `/withdraw <address> <amount> - Withdraw cUSD\n` +
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
  );
});

/**
 * /rate — Check FX rate for a country
 */
bot.command('rate', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const countryCode = parts[1]?.toUpperCase();

  if (!countryCode || countryCode.length < 2 || countryCode.length > 3) {
    await ctx.reply(
      `Usage: /rate <country_code>\n\n` +
      `Examples:\n` +
      `/rate NG - Nigeria (NGN)\n` +
      `/rate KE - Kenya (KES)\n` +
      `/rate GH - Ghana (GHS)\n` +
      `/rate ZA - South Africa (ZAR)`,
    );
    return;
  }

  try {
    const fxData = await getFxRate(countryCode);
    if (!fxData) {
      await ctx.reply(`No rate available for ${countryCode}. Check the country code and try again.`);
      return;
    }

    const { rate, currencyCode } = fxData;
    const examples = [1, 5, 10, 25].map(usd => {
      const local = Math.round(usd * rate);
      return `${usd} cUSD = ${local.toLocaleString()} ${currencyCode}`;
    }).join('\n');

    await ctx.reply(
      `Rate for ${countryCode} (${currencyCode})\n\n` +
      `1 cUSD = ${rate.toLocaleString()} ${currencyCode}\n\n` +
      `${examples}\n\n` +
      `This is the Reloadly delivery rate for airtime/data.`,
    );
  } catch (error: any) {
    await ctx.reply(`Could not fetch rate for ${countryCode}. Try again later.`);
  }
});

/**
 * /settings — Wallet settings menu
 */
bot.command('settings', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (ctx.chat.type !== 'private') {
    await ctx.reply('For security, use this command in a private chat with me.');
    return;
  }

  const settings = await userSettingsStore.get(userId);
  const autoReviewStatus = settings.autoReviewEnabled ? 'ON ✅' : 'OFF ❌';

  await ctx.reply(
    `⚙️ Wallet Settings\n\n` +
    `Choose an option:`,
    Markup.inlineKeyboard([
      [Markup.button.callback(`⭐ Auto-Review: ${autoReviewStatus}`, `toggle_autoreview_${userId}`)],
      [Markup.button.callback('🔑 Export Private Key', `export_confirm_${userId}`)],
      [Markup.button.callback('📊 Transaction History', `history_${userId}`)],
      [Markup.button.callback('💰 Check Balance', `balance_${userId}`)],
      [Markup.button.callback('❌ Close', `settings_close_${userId}`)],
    ]),
  );
});

/**
 * /history — Show transaction history (placeholder)
 */
bot.command('history', async (ctx) => {
  await ctx.reply(
    `📊 Transaction History\n\n` +
    `Coming soon: View your recent airtime, data, bills, and gift card purchases.\n\n` +
    `For now, check your wallet address on Celoscan:\n` +
    `https://celoscan.io`,
  );
});

/**
 * /cancel — Cancel pending order
 */
bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id.toString();
  const order = await pendingOrders.getByUser(userId);

  if (!order) {
    await ctx.reply('You have no pending orders.');
    return;
  }

  await pendingOrders.updateStatus(order.orderId, 'cancelled');
  await pendingOrders.remove(order.orderId);

  await ctx.reply(
    `❌ Order cancelled\n\n` +
    `${order.description}`,
  );
});

/**
 * /clear — Clear conversation memory
 */
bot.command('clear', async (ctx) => {
  const userId = ctx.from.id.toString();
  await clearConversationHistory(userId);
  await ctx.reply('Conversation memory cleared. I won\'t remember our previous chats.');
});

/**
 * /silent — Toggle proactive messages on/off
 */
bot.command('silent', async (ctx) => {
  const userId = ctx.from.id.toString();
  const activity = await getUserActivity(userId);
  const currentlyEnabled = activity?.proactiveEnabled ?? true;
  const newState = !currentlyEnabled;
  await setProactiveEnabled(userId, newState);
  await ctx.reply(
    newState
      ? 'Proactive messages enabled. I\'ll reach out when I have something useful for you.'
      : 'Proactive messages disabled. I\'ll only respond when you message me.',
  );
});

/**
 * /status — Show user's saved instructions, scheduled tasks, and settings
 */
bot.command('status', async (ctx) => {
  const userId = ctx.from.id.toString();

  const [goals, tasks, activity] = await Promise.all([
    getUserGoals(userId),
    getUserScheduledTasks(userId),
    getUserActivity(userId),
  ]);

  const proactiveStatus = (activity?.proactiveEnabled ?? true) ? 'ON' : 'OFF';
  const country = activity?.country || 'Not detected yet';

  let msg = `Your Toppa Profile\n\n`;
  msg += `Proactive messages: ${proactiveStatus} (toggle with /silent)\n`;
  msg += `Detected country: ${country}\n\n`;

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
      msg += `${i + 1}. ${t.description} — ${new Date(t.scheduledAt).toLocaleString()}\n`;
    });
  } else {
    msg += 'No scheduled tasks.';
  }

  await ctx.reply(msg);
});

/**
 * /export — Export private key (now redirects to /settings)
 */
bot.command('export', async (ctx) => {
  await ctx.reply(
    `To export your private key, use /settings\n\n` +
    `This must be done in a private chat for security.`,
  );
});

// ─────────────────────────────────────────────────
// Text Message Handler (AI Agent + Order Detection)
// ─────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const userId = ctx.from.id.toString();

  // Track user activity for heartbeat (non-blocking)
  trackActivity(userId, ctx.chat.id).catch(() => {});

  try {
    // Rate limiting
    const rateLimitCheck = await checkRateLimit(userId);
    if (!rateLimitCheck.allowed) {
      await ctx.reply(rateLimitCheck.reason!);
      return;
    }

    // Sanitize input
    const sanitizedMessage = sanitizeTelegramInput(userMessage);
    await ctx.sendChatAction('typing');

    // Get wallet context
    const { balance, address } = await walletManager.getBalance(userId);

    // Run AI agent with wallet context + chatId for scheduling
    const { response } = await runToppaAgent(sanitizedMessage, {
      userAddress: userId,
      source: 'telegram',
      rateLimited: true,
      walletAddress: address,
      walletBalance: balance,
      chatId: ctx.chat.id,
    } as any);

    const responseText = response as string;

    // Check if agent returned an order confirmation JSON
    // Matches both raw JSON and ```json code blocks (LLM may use either format)
    const orderMatch = responseText.match(
      /```json\s*(\{[\s\S]*?"type"\s*:\s*"order_confirmation"[\s\S]*?\})\s*```/,
    ) || responseText.match(
      /(\{[\s\S]*?"type"\s*:\s*"order_confirmation"[\s\S]*?\})/,
    );

    if (orderMatch) {
      try {
        const orderData = JSON.parse(orderMatch[1]);
        const { total, serviceFee } = calculateTotalPayment(orderData.productAmount);

        const orderId = generateOrderId();
        const order: PendingOrder = {
          orderId,
          telegramId: userId,
          chatId: ctx.chat.id,
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

        const tokenSymbol = TOKEN_SYMBOL;

        await ctx.reply(
          `📋 Order Summary\n\n` +
          `${orderData.description}\n\n` +
          `Amount: ${orderData.productAmount.toFixed(2)} cUSD\n` +
          `Service Fee (1.5%): ${serviceFee.toFixed(2)} cUSD\n` +
          `Total: ${total.toFixed(2)} cUSD\n\n` +
          `Your Balance: ${balance} ${tokenSymbol}\n\n` +
          `Expires in 10 minutes`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm Order', `order_confirm_${orderId}`)],
            [Markup.button.callback('❌ Cancel', `order_cancel_${orderId}`)],
          ]),
        );
      } catch (parseError) {
        // JSON parsing failed — send the raw response
        await ctx.reply(responseText);
      }
    } else {
      // Regular text response from agent
      await ctx.reply(responseText);
    }
  } catch (error: any) {
    console.error('[Telegram Bot Error]', {
      userId,
      error: error.message,
      type: error.name,
    });

    if (error.message.includes('malicious') || error.message.includes('too long')) {
      await ctx.reply(error.message);
    } else if (error.message.includes('INSUFFICIENT_BALANCE') || error.message.includes('balance')) {
      await ctx.reply('Unable to complete request. Please try again later or contact support.');
    } else {
      await ctx.reply('An error occurred processing your request. Please try again.');
    }
  }
});

// ─────────────────────────────────────────────────
// Error Handler
// ─────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('Something went wrong. Please try again.');
});

// ─────────────────────────────────────────────────
// Start Bot
// ─────────────────────────────────────────────────

/**
 * Start the Telegram bot.
 *
 * In production with API_URL set: uses webhook mode mounted on the Express app.
 *   - More efficient: Telegram pushes updates instead of bot polling
 *   - No open long-poll connection consuming resources
 *   - Faster response times (no polling interval delay)
 *
 * In dev / no API_URL: falls back to long-polling (works without public URL).
 */
export async function startTelegramBot(expressApp?: import('express').Express) {
  const apiUrl = process.env.API_URL;
  const webhookPath = `/bot/webhook/${process.env.TELEGRAM_BOT_TOKEN}`;

  // Register command menu so users see commands when they tap /
  await bot.telegram.setMyCommands([
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
  ]);

  if (apiUrl && expressApp) {
    // Webhook mode: mount on existing Express server
    const webhookUrl = `${apiUrl}${webhookPath}`;

    // Set the webhook with Telegram
    await bot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: true, // Don't process messages queued while offline
    });

    // Mount the webhook handler on Express
    expressApp.use(bot.webhookCallback(webhookPath));

    console.log(`Toppa Telegram bot running (webhook: ${apiUrl}/bot/webhook/***)`);
  } else {
    // Long-polling fallback for dev
    // First delete any existing webhook to avoid conflicts
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    bot.launch();
    console.log('Toppa Telegram bot running (long-polling mode)');

    process.once('SIGINT', () => { bot.stop('SIGINT'); stopScheduler(); stopHeartbeat(); });
    process.once('SIGTERM', () => { bot.stop('SIGTERM'); stopScheduler(); stopHeartbeat(); });
  }

  // Start the task scheduler — executes due tasks and notifies users
  startScheduler(async (task: ScheduledTask) => {
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
        expiresAt: Date.now() + 30 * 60 * 1000, // 30 min for scheduled tasks
      };

      await pendingOrders.create(order);

      // Notify the user their scheduled task is ready
      await bot.telegram.sendMessage(
        task.chatId,
        `⏰ Scheduled Task Ready\n\n` +
        `${task.description}\n\n` +
        `Amount: ${task.productAmount.toFixed(2)} cUSD\n` +
        `Service Fee (1.5%): ${serviceFee.toFixed(2)} cUSD\n` +
        `Total: ${total.toFixed(2)} cUSD\n\n` +
        `This was scheduled earlier. Confirm to proceed.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Confirm & Pay', callback_data: `order_confirm_${orderId}` }],
              [{ text: '❌ Skip', callback_data: `order_cancel_${orderId}` }],
            ],
          },
        },
      );

      await markTaskCompleted(task._id!, 'Notification sent — awaiting user confirmation');
    } catch (err: any) {
      console.error(`[Scheduler] Failed to notify user for task ${task._id}:`, err.message);
      await markTaskFailed(task._id!, err.message);
    }
  });

  // Start the heartbeat engine — proactively checks on users every 15 min
  startHeartbeat(async (chatId: number, text: string) => {
    await bot.telegram.sendMessage(chatId, text);
  });
}
