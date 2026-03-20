import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import * as QRCode from 'qrcode-terminal';
import { runToppaAgent } from '../agent/graph';
import { calculateTotalPayment, verifyX402Payment, PAYMENT_TOKEN_SYMBOL } from '../blockchain/x402';
import { reservePaymentHash } from '../blockchain/replay-guard';
import { createReceipt, updateReceipt } from '../blockchain/service-receipts';
import { executeServiceTool, formatServiceResult } from './handlers';
import { userSettingsStore } from './user-settings';
import { invalidateReloadlyBalanceCache } from '../shared/balance-cache';
import { submitAutoReputation } from '../blockchain/reputation';
import { WalletManager } from '../wallet/manager';
import { InMemoryWalletStore } from '../wallet/store';
import { MongoWalletStore } from '../wallet/mongo-store';
import { PendingOrderStore, generateOrderId } from './pending-orders';
import { IS_TESTNET, TOKEN_SYMBOL, CELO_CAIP2, EXPLORER_BASE } from '../shared/constants';
import { saveConversation, clearConversationHistory } from '../agent/memory';
import { getFxRate } from '../apis/reloadly';

const walletStore = process.env.MONGODB_URI
  ? new MongoWalletStore()
  : new InMemoryWalletStore();

const walletManager = new WalletManager(walletStore);
const pendingOrders = new PendingOrderStore();

// Prefix WhatsApp user IDs to avoid collision with Telegram numeric IDs
const waUserId = (phone: string) => `wa_${phone}`;

// In-memory processing lock — prevents duplicate processing of the same message
const userMessageLock = new Map<string, number>();

// Reconnect backoff state
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60_000; // Cap at 60s

// ─────────────────────────────────────────────────
// Rate Limiting (mirrors Telegram — 20 req/min, $50/day)
// ─────────────────────────────────────────────────

interface UserRateLimit {
  requestCount: number;
  lastReset: number;
  totalSpent: number;
  spendingResetDate: number;
}

const userRateLimits = new Map<string, UserRateLimit>();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 20;
const DAILY_SPENDING_LIMIT = 50;
const SPENDING_RESET_WINDOW = 24 * 60 * 60 * 1000;

function checkRateLimit(userId: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  let userLimit = userRateLimits.get(userId);

  if (!userLimit || now - userLimit.lastReset > RATE_LIMIT_WINDOW) {
    userLimit = { requestCount: 0, lastReset: now, totalSpent: 0, spendingResetDate: userLimit?.spendingResetDate || now };
    userRateLimits.set(userId, userLimit);
  }

  if (userLimit.requestCount >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, reason: 'Slow down a bit! Try again in a few seconds.' };
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
  let userLimit = userRateLimits.get(userId);
  if (!userLimit) {
    userLimit = { requestCount: 0, lastReset: Date.now(), totalSpent: 0, spendingResetDate: Date.now() };
    userRateLimits.set(userId, userLimit);
  }
  userLimit.totalSpent += amount;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  pendingOrders.cleanup().catch(() => {});
  const now = Date.now();
  for (const [id, limit] of userRateLimits) {
    if (now - limit.lastReset > 60 * 60 * 1000) userRateLimits.delete(id);
  }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────
// Input Sanitization (mirrors Telegram)
// ─────────────────────────────────────────────────

function sanitizeInput(input: string): string {
  if (input.length > 500) {
    throw new Error('Message too long. Please keep it under 500 characters.');
  }

  const normalized = input
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
    .replace(/[\u0400-\u04FF]/g, (c) => {
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

  return input;
}

// ─────────────────────────────────────────────────
// Markdown Stripping (comprehensive, mirrors Telegram)
// ─────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/(?<!\w)\*(.+?)\*(?!\w)/gs, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/gs, '$1')
    .replace(/~~(.+?)~~/gs, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[\s]*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────────
// Message Splitting (WhatsApp ~65k limit, split at 4000 for readability)
// ─────────────────────────────────────────────────

const WA_MSG_LIMIT = 4000;

async function sendLongMessage(sock: any, jid: string, text: string) {
  if (text.length <= WA_MSG_LIMIT) {
    await sock.sendMessage(jid, { text });
    return;
  }
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= WA_MSG_LIMIT) {
      await sock.sendMessage(jid, { text: remaining });
      break;
    }
    let cut = remaining.lastIndexOf('\n\n', WA_MSG_LIMIT);
    if (cut < WA_MSG_LIMIT / 2) cut = remaining.lastIndexOf('\n', WA_MSG_LIMIT);
    if (cut < WA_MSG_LIMIT / 2) cut = WA_MSG_LIMIT;
    await sock.sendMessage(jid, { text: remaining.slice(0, cut) });
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
}

// ─────────────────────────────────────────────────
// Bot Entry Point
// ─────────────────────────────────────────────────

export async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('wa_auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }) as any
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan the QR code with WhatsApp to connect Toppa.\n');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[WhatsApp] Connection closed:', lastDisconnect?.error?.message || 'unknown');
      if (shouldReconnect) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
        reconnectAttempts++;
        console.log(`[WhatsApp] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
        setTimeout(() => startWhatsAppBot(), delay);
      } else {
        console.log('[WhatsApp] Logged out — not reconnecting. Re-scan QR to reconnect.');
      }
    } else if (connection === 'open') {
      reconnectAttempts = 0;
      console.log('[WhatsApp] Bot is active and ready.');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const senderJid = msg.key.remoteJid;
    if (!senderJid) return;

    // Block group chats — only process private (1:1) messages
    if (senderJid.endsWith('@g.us') || senderJid.endsWith('@broadcast')) {
      return;
    }

    const phone = senderJid.split('@')[0];
    const userId = waUserId(phone);
    const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text;

    if (!rawText) return;

    // Rate limit check
    const rateLimitCheck = checkRateLimit(userId);
    if (!rateLimitCheck.allowed) {
      await sock.sendMessage(senderJid, { text: rateLimitCheck.reason! }).catch(() => {});
      return;
    }

    // Input sanitization
    let text: string;
    try {
      text = sanitizeInput(rawText);
    } catch (err: any) {
      await sock.sendMessage(senderJid, { text: err.message }).catch(() => {});
      return;
    }

    // Processing lock — if already handling a message from this user, skip
    const lockTime = userMessageLock.get(userId);
    if (lockTime && Date.now() - lockTime < 120_000) {
      return;
    }
    userMessageLock.set(userId, Date.now());

    try {
      const { address } = await walletManager.getOrCreateWallet(userId);
      const { balance } = await walletManager.getBalance(userId);

      // ── Commands ──────────────────────────────────────
      if (text.startsWith('/')) {
        await handleCommand(sock, senderJid, userId, text, address, balance);
        return;
      }

      // ── Pending order confirmation ────────────────────
      const activeOrder = await pendingOrders.getByUser(userId);

      // Stale order recovery — if a processing order is >1 min old, mark it failed
      if (activeOrder?.status === 'processing') {
        const orderAge = Date.now() - activeOrder.createdAt;
        const STALE_PROCESSING_MS = 60 * 1000;
        if (orderAge > STALE_PROCESSING_MS) {
          console.warn(`[WhatsApp][StaleOrder] Order ${activeOrder.orderId} stuck for ${Math.round(orderAge / 1000)}s — marking failed`);
          await pendingOrders.updateStatus(activeOrder.orderId, 'failed', {
            error: 'Order timed out (server may have restarted during processing)',
          });
        } else {
          await sock.sendMessage(senderJid, {
            text: 'You have an order being processed right now. Please wait for it to complete before placing a new one.',
          });
          return;
        }
      }

      if (activeOrder && activeOrder.status === 'pending_confirmation') {
        const lowerText = text.trim().toLowerCase();

        if (['yes', 'y', '1', 'confirm'].includes(lowerText)) {
          await processOrderConfirmation(sock, senderJid, userId, address, balance, activeOrder);
          return;
        } else if (['no', 'n', '2', 'cancel'].includes(lowerText)) {
          await pendingOrders.atomicTransition(activeOrder.orderId, ['pending_confirmation', 'pending_payment'], 'cancelled');
          await sock.sendMessage(senderJid, { text: '❌ Order cancelled.' });
          return;
        }
      }

      // ── Agent conversation ────────────────────────────
      await sock.sendPresenceUpdate('composing', senderJid);

      const result = await runToppaAgent(text, {
        userAddress: userId,
        source: 'whatsapp',
        rateLimited: true,
        walletAddress: address,
        walletBalance: balance,
        chatId: userId,
      } as any);
      const response = result.response;

      // Save to conversation memory for multi-turn context
      saveConversation(userId, text, response).catch(() => {});

      // Extract order confirmation JSON if present
      const orderData = extractOrderConfirmation(response);

      if (orderData) {
        // Block new orders while another is processing
        const existingOrder = await pendingOrders.getByUser(userId);
        if (existingOrder?.status === 'processing') {
          await sock.sendMessage(senderJid, {
            text: 'You have an order being processed. Please wait for it to complete.',
          });
          return;
        }

        const { total, serviceFee } = calculateTotalPayment(orderData.productAmount);
        const orderId = generateOrderId();

        await pendingOrders.create({
          orderId,
          telegramId: userId,
          chatId: 0,
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
        });

        const orderMsg = `📋 Order Summary\n\n${orderData.description}\n\nAmount: ${orderData.productAmount.toFixed(2)} ${TOKEN_SYMBOL}\nService Fee (1.5%): ${serviceFee.toFixed(2)} ${TOKEN_SYMBOL}\nTotal: ${total.toFixed(2)} ${TOKEN_SYMBOL}\n\nYour Balance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\n\nReply YES to confirm, or NO to cancel.`;

        await sock.sendMessage(senderJid, { text: orderMsg });
      } else {
        const plain = stripMarkdown(response);
        await sendLongMessage(sock, senderJid, plain);
      }

    } catch (error: any) {
      console.error('[WhatsApp] Error:', error.message);
      await sock.sendMessage(senderJid, { text: 'Something went wrong. Please try again.' }).catch(() => {});
    } finally {
      userMessageLock.delete(userId);
    }
  });
}

// ── Command Handler ───────────────────────────────────

async function handleCommand(
  sock: any, jid: string, userId: string, text: string, address: string, balance: string,
) {
  const cmd = text.split(' ')[0].toLowerCase();

  switch (cmd) {
    case '/start':
      await sock.sendMessage(jid, {
        text: `Welcome to Toppa!\n\nYour Celo wallet:\n${address}\n\nNetwork: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}\nToken: ${TOKEN_SYMBOL}\n\nDeposit ${TOKEN_SYMBOL} to get started.\n\nJust tell me what you need — airtime, data, bills, or gift cards!\n\nType /help for all commands.`
      });
      return;

    case '/wallet':
    case '/balance':
      await sock.sendMessage(jid, {
        text: `💰 Your Wallet\n\nAddress:\n${address}\n\nBalance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\nNetwork: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}`
      });
      return;

    case '/withdraw': {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await sock.sendMessage(jid, {
          text: `Usage: /withdraw <celo_address> <amount>\nExample: /withdraw 0x1234...abcd 10.00`
        });
        return;
      }
      const toAddress = parts[1];
      const amount = parseFloat(parts[2]);
      if (!/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
        await sock.sendMessage(jid, { text: '❌ Invalid Celo address.' });
        return;
      }
      if (!amount || amount <= 0 || !isFinite(amount)) {
        await sock.sendMessage(jid, { text: '❌ Invalid amount. Must be a positive number.' });
        return;
      }
      try {
        await sock.sendMessage(jid, { text: '⏳ Processing withdrawal...' });
        const result = await walletManager.withdraw(userId, toAddress, amount);
        await sock.sendMessage(jid, {
          text: `✅ Withdrawal Complete\n\n${amount.toFixed(2)} ${TOKEN_SYMBOL} sent to:\n${toAddress}\n\nTX: ${EXPLORER_BASE}/tx/${result.txHash}`
        });
      } catch (err: any) {
        await sock.sendMessage(jid, { text: `❌ Withdrawal failed: ${err.message}` });
      }
      return;
    }

    case '/rate': {
      const parts = text.split(' ');
      const countryCode = parts[1]?.toUpperCase();

      if (!countryCode || countryCode.length < 2 || countryCode.length > 3) {
        await sock.sendMessage(jid, {
          text: `Usage: /rate <country_code>\n\nExamples:\n/rate NG - Nigeria (NGN)\n/rate KE - Kenya (KES)\n/rate GH - Ghana (GHS)\n/rate ZA - South Africa (ZAR)`
        });
        return;
      }

      try {
        const fxData = await getFxRate(countryCode);
        if (!fxData) {
          await sock.sendMessage(jid, { text: `No rate available for ${countryCode}. Check the country code and try again.` });
          return;
        }

        const { rate, currencyCode } = fxData;
        const examples = [1, 5, 10, 25].map(usd => {
          const local = Math.round(usd * rate);
          return `${usd} ${TOKEN_SYMBOL} = ${local.toLocaleString('en-US')} ${currencyCode}`;
        }).join('\n');

        await sock.sendMessage(jid, {
          text: `Rate for ${countryCode} (${currencyCode})\n\n1 ${TOKEN_SYMBOL} = ${rate.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currencyCode}\n\n${examples}`
        });
      } catch (err: any) {
        await sock.sendMessage(jid, { text: `Couldn't fetch rate for ${countryCode}. Try again later.` });
      }
      return;
    }

    case '/cancel': {
      const activeOrder = await pendingOrders.getByUser(userId);
      if (activeOrder && (activeOrder.status === 'pending_confirmation' || activeOrder.status === 'pending_payment')) {
        await pendingOrders.atomicTransition(activeOrder.orderId, ['pending_confirmation', 'pending_payment'], 'cancelled');
        await sock.sendMessage(jid, { text: '❌ Pending order cancelled.' });
      } else {
        await sock.sendMessage(jid, { text: 'No pending order to cancel.' });
      }
      return;
    }

    case '/settings': {
      const settings = await userSettingsStore.get(userId);
      await sock.sendMessage(jid, {
        text: `⚙️ Settings\n\nAuto-review: ${settings.autoReviewEnabled ? 'ON' : 'OFF'}\n\nCommands:\n/togglereview - Toggle auto-review\n/export - Export private key`
      });
      return;
    }

    case '/togglereview': {
      const newValue = await userSettingsStore.toggleAutoReview(userId);
      await sock.sendMessage(jid, {
        text: `Auto-review is now ${newValue ? 'ON' : 'OFF'}.\n\n${newValue ? 'A 5★ reputation score will be submitted on-chain after each successful purchase.' : 'No automatic reviews will be submitted.'}`
      });
      return;
    }

    case '/export': {
      try {
        const pk = await walletManager.exportPrivateKey(userId);
        await sock.sendMessage(jid, {
          text: `⚠️ PRIVATE KEY — DO NOT SHARE\n\n${pk}\n\nImport this into any Celo-compatible wallet (MetaMask, Valora, etc).\n\nDelete this message after saving your key.`
        });
      } catch (err: any) {
        await sock.sendMessage(jid, { text: '❌ Could not export key. Try /start first.' });
      }
      return;
    }

    case '/clear':
      await clearConversationHistory(userId);
      await sock.sendMessage(jid, { text: 'Conversation history cleared.' });
      return;

    case '/help':
      await sock.sendMessage(jid, {
        text: `Toppa — Airtime, Data, Bills & Gift Cards on Celo\n\nCommands:\n/start - Create wallet & get started\n/wallet - Check balance & address\n/withdraw <address> <amount> - Withdraw ${TOKEN_SYMBOL}\n/rate <country> - Check FX rate (e.g. /rate NG)\n/cancel - Cancel pending order\n/settings - View settings\n/togglereview - Toggle auto-review\n/export - Export private key\n/clear - Clear conversation memory\n/help - Show this message\n\nOr just type what you need:\n"Send 500 NGN airtime to 08012345678"\n"Buy 1GB data for +254712345678"\n"Pay my DSTV subscription"`
      });
      return;

    default:
      await sock.sendMessage(jid, { text: 'Unknown command. Type /help to see available commands.' });
      return;
  }
}

// ── Order Confirmation Processing ─────────────────────

async function processOrderConfirmation(
  sock: any, jid: string, userId: string, address: string, balance: string, activeOrder: any,
) {
  // Atomic transition to prevent double-confirmation races
  const transitioned = await pendingOrders.atomicTransition(
    activeOrder.orderId, 'pending_confirmation', 'processing',
  );
  if (!transitioned) {
    await sock.sendMessage(jid, { text: 'This order has already been processed.' });
    return;
  }

  const balanceNum = parseFloat(balance);
  const GAS_RESERVE = 0.05;
  const usableBalance = balanceNum - GAS_RESERVE;

  if (usableBalance < activeOrder.totalAmount) {
    await pendingOrders.updateStatus(activeOrder.orderId, 'pending_confirmation');
    const shortage = activeOrder.totalAmount - usableBalance;
    await sock.sendMessage(jid, {
      text: `❌ Insufficient Balance\n\nRequired: ${activeOrder.totalAmount.toFixed(2)} ${TOKEN_SYMBOL}\nAvailable: ${usableBalance > 0 ? usableBalance.toFixed(2) : '0.00'} ${TOKEN_SYMBOL} (after gas)\nShort by: ${shortage.toFixed(2)} ${TOKEN_SYMBOL}\n\nDeposit ${TOKEN_SYMBOL} to:\n${address}`
    });
    return;
  }

  await sock.sendMessage(jid, { text: '⏳ Processing payment (1/4)...' });

  let receiptId = '';
  let paymentTxHash = '';
  let serviceSucceeded = false;

  try {
    const { txHash } = await walletManager.transferToAgent(userId, activeOrder.totalAmount);
    paymentTxHash = txHash;

    await sock.sendMessage(jid, { text: '⏳ Verifying on-chain (2/4)...' });
    await reservePaymentHash(txHash, 'whatsapp');
    const verification = await verifyX402Payment(txHash, activeOrder.totalAmount);
    if (!verification.verified) throw new Error(`Payment verification failed: ${verification.error}`);

    await sock.sendMessage(jid, { text: '⏳ Creating receipt (3/4)...' });
    const serviceType = activeOrder.action === 'airtime' ? 'airtime' :
                        activeOrder.action === 'data' ? 'data' :
                        activeOrder.action === 'bill' ? 'bill_payment' : 'gift_card';

    receiptId = await createReceipt({
      paymentTxHash: txHash,
      payer: address,
      paymentAmount: activeOrder.totalAmount.toString(),
      paymentToken: PAYMENT_TOKEN_SYMBOL,
      paymentNetwork: CELO_CAIP2,
      serviceType,
      source: 'whatsapp',
      serviceArgs: { toolName: activeOrder.toolName, ...activeOrder.toolArgs },
    });

    await sock.sendMessage(jid, { text: '⏳ Executing service (4/4)...' });
    const result = await executeServiceTool(activeOrder.toolName, activeOrder.toolArgs);
    serviceSucceeded = true;

    await updateReceipt(receiptId, {
      status: 'success',
      reloadlyTransactionId: result.transactionId,
      reloadlyStatus: result.status,
      serviceResult: { toolName: activeOrder.toolName },
    });

    invalidateReloadlyBalanceCache();
    recordSpending(userId, activeOrder.totalAmount);
    await pendingOrders.updateStatus(activeOrder.orderId, 'completed', { txHash, result });

    const formattedResult = formatServiceResult(activeOrder.toolName, result, activeOrder);
    const { balance: newBalance } = await walletManager.getBalance(userId);

    const completionTitle = activeOrder.action.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
    await sock.sendMessage(jid, {
      text: `✅ ${completionTitle} Complete!\n\n${formattedResult}\n\nBalance: ${parseFloat(newBalance).toFixed(2)} ${TOKEN_SYMBOL}\nTX: ${EXPLORER_BASE}/tx/${txHash}`
    });

    const userSettings = await userSettingsStore.get(userId);
    if (userSettings.autoReviewEnabled) {
      const userPrivateKey = await walletManager.exportPrivateKey(userId);
      submitAutoReputation({ rating: 100, serviceType: serviceType as any, success: true, userPrivateKey }).catch(() => {});
    }
  } catch (error: any) {
    if (receiptId) await updateReceipt(receiptId, { status: 'failed', error: error.message });
    await pendingOrders.updateStatus(activeOrder.orderId, 'failed', { error: error.message });

    let refunded = false;
    if (paymentTxHash && !serviceSucceeded) {
      try {
        const refundResult = await walletManager.refundUser(userId, activeOrder.totalAmount, paymentTxHash);
        if (receiptId) await updateReceipt(receiptId, { refundTxHash: refundResult.txHash });
        refunded = true;
      } catch (e: any) { }
    }

    let userMsg = 'Transaction failed. Please try again or contact support.';
    if (error.message.includes('Insufficient balance') || error.message.includes('Insufficient cUSD') || error.message.includes('transfer amount exceeds')) {
       userMsg = `You don't have enough ${TOKEN_SYMBOL} to complete this payment.`;
    } else if (error.message.includes('OPERATOR') || error.message.includes('operator')) {
       userMsg = 'Service provider error. Please check your details and try again.';
    }

    if (refunded) {
      userMsg += `\n\n${activeOrder.totalAmount.toFixed(2)} ${TOKEN_SYMBOL} has been refunded to your wallet.`;
    } else if (paymentTxHash && !serviceSucceeded) {
      userMsg += `\n\nYour payment is being reviewed for a refund.`;
    }

    await sock.sendMessage(jid, { text: `❌ Transaction Failed\n\n${userMsg}` });
  }
}

// ── JSON Extraction ───────────────────────────────────

function extractOrderConfirmation(response: string): any {
  try {
    const parsed = JSON.parse(response);
    if (parsed?.type === 'order_confirmation') return parsed;
  } catch {
    const idx = response.indexOf('"order_confirmation"');
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
              if (extracted?.type === 'order_confirmation') return extracted;
            } catch { }
            break;
          }
        }
      }
    }
  }
  return null;
}
