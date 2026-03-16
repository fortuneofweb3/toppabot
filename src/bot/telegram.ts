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
import { startScheduler, stopScheduler, markTaskCompleted, markTaskFailed, ScheduledTask } from '../agent/scheduler';
import { clearConversationHistory } from '../agent/memory';

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

// Cleanup expired orders and stale rate limits every 5 minutes
setInterval(() => {
  pendingOrders.cleanup();
  // Prune stale rate limit entries (inactive for > 1 hour)
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

function checkRateLimit(userId: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  let userLimit = userRateLimits.get(userId);

  if (!userLimit || now - userLimit.lastReset > RATE_LIMIT_WINDOW) {
    userLimit = { requestCount: 0, lastReset: now, totalSpent: 0, spendingResetDate: now };
    userRateLimits.set(userId, userLimit);
  }

  if (userLimit.requestCount >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, reason: 'Too many requests. Please wait 5 minutes.' };
  }

  if (now - userLimit.spendingResetDate > SPENDING_RESET_WINDOW) {
    userLimit.totalSpent = 0;
    userLimit.spendingResetDate = now;
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
    `⚠️ Only deposit ${tokenSymbol} on this network!\n` +
    `Sending other tokens will result in permanent loss.\n\n` +
    `I can:\n` +
    `• Airtime & data (170+ countries)\n` +
    `• Utility bills (electricity, water, TV)\n` +
    `• Gift cards (300+ brands)\n\n` +
    `Commands: /help`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔍 View on Celoscan', url: explorerUrl }
        ]]
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
    `💡 Toppa Commands\n\n` +
    `/start - Create your wallet & get started\n` +
    `/wallet - Check balance & deposit address\n` +
    `/withdraw <address> <amount> - Withdraw cUSD\n` +
    `/settings - Wallet settings & export key\n` +
    `/history - View recent transactions\n` +
    `/cancel - Cancel pending order\n` +
    `/help - Show this help message\n\n` +
    `💬 Just tell me what you need:\n` +
    `• "Send $5 airtime to +234... in Nigeria"\n` +
    `• "Buy a $25 Steam gift card"\n` +
    `• "Pay my DStv bill for 1234567"\n` +
    `• "Get me 5GB data for +254... in Kenya"\n\n` +
    `I support 170+ countries, 800+ operators, and 300+ gift card brands!`,
  );
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

  const settings = userSettingsStore.get(userId);
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
  const order = pendingOrders.getByUser(userId);

  if (!order) {
    await ctx.reply('You have no pending orders.');
    return;
  }

  pendingOrders.updateStatus(order.orderId, 'cancelled');
  pendingOrders.remove(order.orderId);

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
 * /export — Export private key (now redirects to /settings)
 */
bot.command('export', async (ctx) => {
  await ctx.reply(
    `🔑 To export your private key, use /settings\n\n` +
    `This must be done in a private chat for security.`,
  );
});

// ─────────────────────────────────────────────────
// Text Message Handler (AI Agent + Order Detection)
// ─────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const userId = ctx.from.id.toString();

  try {
    // Rate limiting
    const rateLimitCheck = checkRateLimit(userId);
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
    const orderMatch = responseText.match(
      /```json\s*(\{[\s\S]*?"type"\s*:\s*"order_confirmation"[\s\S]*?\})\s*```/,
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

        pendingOrders.create(order);

        const tokenSymbol = TOKEN_SYMBOL;

        await ctx.reply(
          `📋 Order Summary\n\n` +
          `${orderData.description}\n\n` +
          `Amount: $${orderData.productAmount.toFixed(2)}\n` +
          `Service Fee (1.5%): $${serviceFee.toFixed(2)}\n` +
          `Total: $${total.toFixed(2)} ${tokenSymbol}\n\n` +
          `Your Balance: ${balance} ${tokenSymbol}\n\n` +
          `⏱ Expires in 10 minutes`,
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

    process.once('SIGINT', () => { bot.stop('SIGINT'); stopScheduler(); });
    process.once('SIGTERM', () => { bot.stop('SIGTERM'); stopScheduler(); });
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

      pendingOrders.create(order);
      const tokenSymbol = TOKEN_SYMBOL;

      // Notify the user their scheduled task is ready
      await bot.telegram.sendMessage(
        task.chatId,
        `⏰ Scheduled Task Ready\n\n` +
        `${task.description}\n\n` +
        `Amount: $${task.productAmount.toFixed(2)}\n` +
        `Service Fee (1.5%): $${serviceFee.toFixed(2)}\n` +
        `Total: $${total.toFixed(2)} ${tokenSymbol}\n\n` +
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
}
