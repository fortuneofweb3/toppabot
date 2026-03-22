import crypto from 'node:crypto';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, getAggregateVotesInPollMessage, downloadMediaMessage, proto } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import * as QRCode from 'qrcode-terminal';
import { runToppaAgent } from '../../agent/graph';
import { calculateTotalPayment, verifyX402Payment, PAYMENT_TOKEN_SYMBOL } from '../../blockchain/x402';
import { reservePaymentHash } from '../../blockchain/replay-guard';
import { createReceipt, updateReceipt } from '../../blockchain/service-receipts';
import { executeServiceTool, formatServiceResult } from '../service-executor';
import { userSettingsStore } from '../user-settings';
import { invalidateReloadlyBalanceCache } from '../../shared/balance-cache';
import { submitAutoReputation } from '../../blockchain/reputation';
import { WalletManager } from '../../wallet/manager';
import { InMemoryWalletStore } from '../../wallet/store';
import { MongoWalletStore } from '../../wallet/mongo-store';
import { PendingOrderStore, generateOrderId } from '../pending-orders';
import { IS_TESTNET, TOKEN_SYMBOL, CELO_CAIP2, EXPLORER_BASE } from '../../shared/constants';
import { saveConversation, clearConversationHistory } from '../../agent/memory';
import { getFxRate } from '../../apis/reloadly';
import { getAllBalances } from '../../blockchain/swap';
import { enableGroup, getGroup, isGroupAdmin, getGroupBalance, contributeToGroup, groupWithdraw, getGroupTransactions, getMemberContributions, setPollThreshold, createGroupPoll, recordPollVote, getActivePolls, getPollById, closePoll, setPollingEnabled, getMostRecentActivePoll } from '../groups';
import { getUserScheduledTasks, getUserRecurringTasks, adminCancelScheduledTask, adminCancelRecurringTask } from '../../agent/scheduler';
import { recordGroupMsg, buildGroupContext as buildGroupCtx } from '../group-context';
import { detectInjection } from '../../shared/sanitize';

const walletStore = process.env.MONGODB_URI
  ? new MongoWalletStore()
  : new InMemoryWalletStore();

const walletManager = new WalletManager(walletStore);
const pendingOrders = new PendingOrderStore();

// Prefix WhatsApp user IDs to avoid collision with Telegram numeric IDs
const waUserId = (phone: string) => `wa_${phone}`;

// In-memory processing lock — prevents duplicate processing of the same message
const userMessageLock = new Map<string, number>();

// Poll message store — maps sent poll message ID to our internal poll + original message
// Needed to decrypt poll updates via getAggregateVotesInPollMessage
interface StoredPollMsg {
  pollId: string;
  groupId: string;
  message: proto.IMessage;    // Original poll creation message for decryption
  messageKey: proto.IMessageKey;  // Full key for pin/unpin
  jid: string;                    // Chat JID for pin/unpin
}
const pollMessageStore = new Map<string, StoredPollMsg>();

// Gift card claims — stores codes for targeted gift card deliveries in WhatsApp groups.
// Key: 8-char hex ID. Recipient can DM /claim <id> to get their code.
const GIFT_CARD_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const giftCardClaims = new Map<string, { codes: any; recipientUserId: string; orderId: string; expiresAt: number }>();

// Bot's own JID — populated on connection open
let botJid = '';

/** Find a stored poll message by internal pollId (for unpinning). */
function findStoredPollByPollId(pollId: string): StoredPollMsg | undefined {
  for (const stored of pollMessageStore.values()) {
    if (stored.pollId === pollId) return stored;
  }
  return undefined;
}

/** Unpin a poll message in the group. Non-critical — silently fails. */
async function unpinPollMessage(sock: any, pollId: string): Promise<void> {
  const stored = findStoredPollByPollId(pollId);
  if (!stored) return;
  try {
    // PinInChat.Type: 1 = PIN_FOR_ALL, 2 = UNPIN_FOR_ALL
    await sock.sendMessage(stored.jid, { pin: stored.messageKey, type: 2, time: 0 });
  } catch {
    // Bot may lack unpin permissions
  }
}

// ─────────────────────────────────────────────────
// Group @Mention Infrastructure
// ─────────────────────────────────────────────────

/** Check if the bot is @mentioned or replied to in a WhatsApp group message. */
function isBotMentionedWA(msg: any, rawText: string | undefined): boolean {
  if (!botJid) return false;
  const botPhone = botJid.split('@')[0]?.split(':')[0];
  if (!botPhone) return false;

  // Check mentionedJid array (WhatsApp native mentions)
  const mentionedJids: string[] = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (mentionedJids.some((jid: string) => jid.split('@')[0]?.split(':')[0] === botPhone)) return true;

  // Check if replying to bot's own message
  const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (quotedParticipant?.split('@')[0]?.split(':')[0] === botPhone) return true;

  // Check text for @phone mention
  if (rawText?.includes(`@${botPhone}`)) return true;

  return false;
}

/** Build WhatsApp-specific group context (extracts quoted text from contextInfo). */
function buildWAGroupContext(msg: any, groupId: string): string {
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
  return buildGroupCtx(groupId, quotedText || undefined);
}

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
const SPENDING_RESET_WINDOW = 24 * 60 * 60 * 1000;

async function checkRateLimit(userId: string): Promise<{ allowed: boolean; reason?: string }> {
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

  // Self Protocol tiered limits: verified users get higher daily cap
  const { getDailySpendingLimit } = await import('../../blockchain/self-verification');
  const userDailyLimit = await getDailySpendingLimit(userId);
  if (userLimit.totalSpent >= userDailyLimit) {
    const isLowTier = userDailyLimit <= 20;
    const reason = isLowTier
      ? `Daily limit of $${userDailyLimit} reached. Verify with Self Protocol to unlock $200/day! Use /verify to get started.`
      : `Daily spending limit of $${userDailyLimit} reached. Try again tomorrow.`;
    return { allowed: false, reason };
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
  const match = detectInjection(input);
  if (match) {
    throw new Error('Message contains potentially malicious content. Please rephrase.');
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
      botJid = sock.user?.id || '';
      console.log(`[WhatsApp] Bot is active and ready. JID: ${botJid}`);
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const senderJid = msg.key.remoteJid;
    if (!senderJid) return;

    // Block broadcasts, allow groups
    if (senderJid.endsWith('@broadcast')) return;

    const isGroupChat = senderJid.endsWith('@g.us');
    // In groups, the sender is in msg.key.participant; in private chats, it's the JID
    const phone = isGroupChat
      ? (msg.key.participant || '').split('@')[0]
      : senderJid.split('@')[0];
    if (!phone) return;
    const userId = waUserId(phone);
    const groupId = isGroupChat ? senderJid : null;
    let rawText = msg.message.conversation || msg.message.extendedTextMessage?.text;
    let isVoiceTranscription = false;

    // ── Voice note transcription (Deepgram) ────────────
    const audioMsg = msg.message.audioMessage;
    if (!rawText && audioMsg) {
      // In groups, only process voice notes that @mention or reply to the bot
      if (isGroupChat && !isBotMentionedWA(msg, undefined)) return;

      const dgKey = process.env.DEEPGRAM_API_KEY;
      if (!dgKey) {
        await sock.sendMessage(senderJid, { text: 'Voice notes are not configured. Please type your request.' }).catch(() => {});
        return;
      }

      // Duration check — 2 minutes max
      const duration = audioMsg.seconds || 0;
      if (duration > 120) {
        await sock.sendMessage(senderJid, { text: 'Voice message too long — keep it under 2 minutes.' }).catch(() => {});
        return;
      }

      try {
        await sock.sendPresenceUpdate('composing', senderJid);
        const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
        const mimeType = audioMsg.mimetype || 'audio/ogg';

        const dgResponse = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
          method: 'POST',
          headers: { 'Authorization': `Token ${dgKey}`, 'Content-Type': mimeType },
          body: audioBuffer,
        });

        if (!dgResponse.ok) throw new Error(`Deepgram ${dgResponse.status}`);
        const dgResult = await dgResponse.json() as any;
        const transcript = dgResult?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
        if (!transcript) {
          await sock.sendMessage(senderJid, { text: "Couldn't understand the voice message. Try again or type your request." }).catch(() => {});
          return;
        }

        console.log(`[WhatsApp Voice] ${userId}: "${transcript.slice(0, 80)}..." (${duration}s)`);
        rawText = transcript;
        isVoiceTranscription = true;
      } catch (err: any) {
        console.error('[WhatsApp Voice] Transcription failed:', err.message);
        await sock.sendMessage(senderJid, { text: "Couldn't process that voice message. Try typing your request instead." }).catch(() => {});
        return;
      }
    }

    if (!rawText) return;

    // In groups: record history + enforce @mention-only for free text
    if (isGroupChat && groupId) {
      recordGroupMsg(groupId, userId, rawText);
      // Voice transcriptions already passed mention check before transcription — skip re-check
      if (!isVoiceTranscription && !rawText.startsWith('/')) {
        if (!isBotMentionedWA(msg, rawText)) return;
      }
    }

    // Rate limit check
    const rateLimitCheck = await checkRateLimit(userId);
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
        await handleCommand(sock, senderJid, userId, text, address, balance, groupId);
        return;
      }

      // ── Pending order confirmation ────────────────────
      let activeOrder = await pendingOrders.getByUser(userId);

      // Also check for group orders — admin can confirm group wallet spends
      if (!activeOrder && groupId) {
        const grp = await getGroup(groupId);
        if (grp && isGroupAdmin(grp, userId)) {
          activeOrder = await pendingOrders.getByUser(grp.walletId);
        }
      }

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
          // For group orders, use group wallet balance instead of personal
          const isGroupOrder = activeOrder.telegramId.startsWith('group_');
          const orderBalance = isGroupOrder
            ? (await walletManager.getBalance(activeOrder.telegramId)).balance
            : balance;
          const orderAddress = isGroupOrder
            ? (await walletManager.getBalance(activeOrder.telegramId)).address
            : address;
          await processOrderConfirmation(sock, senderJid, userId, orderAddress, orderBalance, activeOrder);
          return;
        } else if (['no', 'n', '2', 'cancel'].includes(lowerText)) {
          await pendingOrders.atomicTransition(activeOrder.orderId, ['pending_confirmation', 'pending_payment'], 'cancelled');
          await sock.sendMessage(senderJid, { text: '❌ Order cancelled.' });
          return;
        }
      }

      // ── Agent conversation ────────────────────────────
      await sock.sendPresenceUpdate('composing', senderJid);

      // Build group context and strip bot mention from message
      let messageForAgent = text;
      if (isGroupChat && groupId) {
        const groupCtx = buildWAGroupContext(msg, groupId);
        let cleanText = text;
        if (botJid) {
          const botPhone = botJid.split('@')[0]?.split(':')[0];
          if (botPhone) cleanText = cleanText.replace(new RegExp(`@${botPhone}`, 'g'), '').trim();
        }
        messageForAgent = groupCtx ? `${groupCtx}\n\n${cleanText}` : cleanText;
      }

      const userTz = await userSettingsStore.getTimezone(userId);
      const result = await runToppaAgent(messageForAgent, {
        userAddress: userId,
        source: 'whatsapp',
        rateLimited: true,
        walletAddress: address,
        walletBalance: balance,
        chatId: 0,
        timezone: userTz,
        groupId: groupId || undefined,
      });
      const response = result.response;

      // Save to conversation memory for multi-turn context
      saveConversation(userId, text, response).catch(() => {});

      // Extract poll creation request if present
      const pollData = extractJsonByType(response, 'create_poll');
      if (pollData && groupId) {
        try {
          await sendWhatsAppGroupPoll(sock, senderJid, {
            groupId,
            createdBy: userId,
            description: pollData.description,
            service: pollData.service,
            amount: pollData.amount,
            details: pollData.details,
          });
        } catch (err: any) {
          await sock.sendMessage(senderJid, { text: `Failed to create poll: ${err.message}` });
        }
        return;
      }

      // Extract statement report if present — send as document
      const reportData = extractJsonByType(response, 'statement_report');
      if (reportData?.reportId) {
        try {
          const { getReportFromCache } = await import('../../agent/tools');
          const report = getReportFromCache(reportData.reportId);
          if (report) {
            await sock.sendMessage(senderJid, {
              document: report.buffer,
              mimetype: report.mimeType,
              fileName: report.filename,
              caption: `Your ${reportData.format?.toUpperCase() || ''} statement is ready.`,
            });
          } else {
            await sock.sendMessage(senderJid, { text: 'Report expired. Please generate it again.' });
          }
        } catch (err: any) {
          await sock.sendMessage(senderJid, { text: `Failed to send report: ${err.message}` });
        }
        return;
      }

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

  // ── Poll Vote Tracking ──────────────────────────────
  // Listen for poll updates to automatically track who voted
  sock.ev.on('messages.update', async (updates: any[]) => {
    for (const update of updates) {
      if (!update.update?.pollUpdates) continue;

      const msgId = update.key?.id;
      if (!msgId) continue;

      const stored = pollMessageStore.get(msgId);
      if (!stored) continue; // Not one of our polls

      try {
        const votes = getAggregateVotesInPollMessage(
          { message: stored.message, pollUpdates: update.update.pollUpdates },
        );

        // votes = [{ name: 'Yes', voters: ['1234@s.whatsapp.net', ...] }, { name: 'No', voters: [...] }]
        const yesVoters = votes.find(v => v.name === 'Yes')?.voters || [];
        const noVoters = votes.find(v => v.name === 'No')?.voters || [];

        // Record each vote (phone extracted from JID)
        for (const voterJid of yesVoters) {
          const phone = voterJid.split('@')[0];
          const voterId = waUserId(phone);
          await recordPollVote(stored.pollId, voterId, 'yes');
        }
        for (const voterJid of noVoters) {
          const phone = voterJid.split('@')[0];
          const voterId = waUserId(phone);
          await recordPollVote(stored.pollId, voterId, 'no');
        }

        // Check final result after processing all votes
        const poll = await getPollById(stored.pollId);
        if (!poll) continue;

        const groupJid = update.key?.remoteJid;
        if (!groupJid) continue;

        if (poll.status === 'approved') {
          pollMessageStore.delete(msgId); // Cleanup
          await handleWhatsAppVoteResult(sock, groupJid, poll, {
            yesCount: poll.yesVotes.length,
            noCount: poll.noVotes.length,
            totalMembers: poll.totalMembers,
            threshold: poll.threshold,
            status: 'approved',
          }, '');
        } else if (poll.status === 'rejected') {
          pollMessageStore.delete(msgId);
          await handleWhatsAppVoteResult(sock, groupJid, poll, {
            yesCount: poll.yesVotes.length,
            noCount: poll.noVotes.length,
            totalMembers: poll.totalMembers,
            threshold: poll.threshold,
            status: 'rejected',
          }, '');
        }
      } catch (err: any) {
        console.error('[WhatsApp][Poll] Vote tracking error:', err.message);
      }
    }
  });
}

// ── Command Handler ───────────────────────────────────

async function handleCommand(
  sock: any, jid: string, userId: string, text: string, address: string, balance: string, groupId?: string | null,
) {
  const cmd = text.split(' ')[0].toLowerCase();

  switch (cmd) {
    case '/start':
      await sock.sendMessage(jid, {
        text: `Welcome to Toppa!\n\nYour Celo wallet:\n${address}\n\nNetwork: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}\nSupported tokens: cUSD, CELO, USDC, USDT, cEUR\n\nDeposit any supported token to get started.\nUse /swap to convert all tokens to cUSD.\n\nJust tell me what you need — airtime, data, bills, or gift cards!\n\nType /help for all commands.`
      });
      return;

    case '/wallet':
    case '/balance': {
      try {
        const allBalances = await getAllBalances(address as `0x${string}`);
        const balanceLines = allBalances
          .map(b => `${b.symbol}: ${parseFloat(b.balance).toFixed(4)}`)
          .join('\n');
        await sock.sendMessage(jid, {
          text: `Your Wallet\n\nAddress:\n${address}\n\n${balanceLines}\n\nNetwork: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}\n\nDeposit any supported token (cUSD, CELO, USDC, USDT, cEUR).\nUse /swap to convert all tokens to cUSD.`
        });
      } catch {
        await sock.sendMessage(jid, {
          text: `Your Wallet\n\nAddress:\n${address}\n\nBalance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\nNetwork: Celo ${IS_TESTNET ? 'Sepolia Testnet' : 'Mainnet'}`
        });
      }
      return;
    }

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
      // Security: only allow in private chats — never expose private keys in groups
      if (groupId) {
        await sock.sendMessage(jid, { text: '⚠️ For security, /export only works in private chats. Message me directly.' });
        return;
      }
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

    case '/swap': {
      try {
        await sock.sendMessage(jid, { text: 'Checking for non-cUSD tokens to swap...' });
        const results = await walletManager.autoSwapToCUSD(userId);
        if (results.length === 0) {
          await sock.sendMessage(jid, {
            text: 'No non-cUSD tokens to swap. Your wallet only has cUSD (or zero balances for other tokens).'
          });
        } else {
          const summary = results.map(r =>
            `${r.symbol}: ${parseFloat(r.amountSwapped).toFixed(4)} → ${parseFloat(r.cUSDReceived).toFixed(4)} cUSD`
          ).join('\n');
          const { balance: newBal } = await walletManager.getBalance(userId);
          await sock.sendMessage(jid, {
            text: `Swap Complete!\n\n${summary}\n\nNew cUSD balance: ${parseFloat(newBal).toFixed(2)} cUSD`
          });
        }
      } catch (err: any) {
        await sock.sendMessage(jid, {
          text: `Swap failed: ${err.message}\n\nTry again later or check your balance with /wallet.`
        });
      }
      return;
    }

    case '/clear':
      await clearConversationHistory(userId);
      await sock.sendMessage(jid, { text: 'Conversation history cleared.' });
      return;

    case '/verify': {
      try {
        const { createVerificationSession, getUserVerificationStatus, formatVerificationMessage, formatAlreadyVerifiedMessage } = await import('../../blockchain/self-verification');
        const { link, alreadyVerified } = await createVerificationSession(
          userId,
          'whatsapp',
          jid,
        );

        if (alreadyVerified) {
          const status = await getUserVerificationStatus(userId);
          await sock.sendMessage(jid, { text: formatAlreadyVerifiedMessage(status.verifiedAt) });
          return;
        }

        await sock.sendMessage(jid, { text: formatVerificationMessage(link) });
      } catch (err: any) {
        console.error('[WA Verify] Error:', err.message);
        await sock.sendMessage(jid, { text: 'Verification is temporarily unavailable. Please try again later.' });
      }
      return;
    }

    case '/group': {
      if (!groupId) {
        await sock.sendMessage(jid, { text: 'This command only works in group chats.' });
        return;
      }

      const subCmd = text.split(/\s+/)[1]?.toLowerCase();

      if (subCmd === 'enable') {
        const existing = await getGroup(groupId);
        if (existing) {
          const { balance: gBal } = await getGroupBalance(existing, walletManager);
          await sock.sendMessage(jid, { text: `Group wallet already enabled!\n\nAddress: ${existing.walletAddress}\nBalance: ${parseFloat(gBal).toFixed(2)} ${TOKEN_SYMBOL}` });
          return;
        }
        const group = await enableGroup(groupId, 'whatsapp', 'WhatsApp Group', userId, walletManager);
        await sock.sendMessage(jid, {
          text: `Group wallet enabled!\n\nWallet: ${group.walletAddress}\nAdmin: you\n\nMembers can /contribute cUSD to the group wallet.\nAdmin can /group_withdraw to external addresses.`
        });
        return;
      }

      const group = await getGroup(groupId);
      if (!group) {
        await sock.sendMessage(jid, { text: 'No group wallet set up. An admin can run /group enable to create one.' });
        return;
      }

      const { balance: gBal } = await getGroupBalance(group, walletManager);
      const contributions = await getMemberContributions(groupId);
      const recentTxs = await getGroupTransactions(groupId, 5);

      let info = `${group.name} — Group Wallet\n\nAddress: ${group.walletAddress}\nBalance: ${parseFloat(gBal).toFixed(2)} ${TOKEN_SYMBOL}\nMembers: ${group.members.length}\n`;

      if (contributions.length > 0) {
        info += `\nContributions:\n`;
        for (const c of contributions.slice(0, 10)) {
          info += `  ${c.userId}: ${c.total.toFixed(2)} ${TOKEN_SYMBOL}\n`;
        }
      }

      if (recentTxs.length > 0) {
        info += `\nRecent Activity:\n`;
        for (const tx of recentTxs) {
          info += `  ${tx.createdAt.toLocaleDateString()} | ${tx.type} | ${tx.amount.toFixed(2)} ${TOKEN_SYMBOL}\n`;
        }
      }

      await sock.sendMessage(jid, { text: info });
      return;
    }

    case '/contribute': {
      if (!groupId) {
        await sock.sendMessage(jid, { text: 'This command only works in group chats.' });
        return;
      }
      const group = await getGroup(groupId);
      if (!group) {
        await sock.sendMessage(jid, { text: 'No group wallet set up. Run /group enable first.' });
        return;
      }
      const cAmount = parseFloat(text.split(/\s+/)[1]);
      if (!cAmount || !isFinite(cAmount) || cAmount <= 0) {
        await sock.sendMessage(jid, { text: 'Usage: /contribute <amount>\nExample: /contribute 5.00' });
        return;
      }
      try {
        await sock.sendMessage(jid, { text: `Contributing ${cAmount.toFixed(2)} ${TOKEN_SYMBOL} to group wallet...` });
        const result = await contributeToGroup(group, userId, cAmount, walletManager);
        const { balance: newGBal } = await getGroupBalance(group, walletManager);
        await sock.sendMessage(jid, {
          text: `Contribution complete!\n\nAmount: ${cAmount.toFixed(2)} ${TOKEN_SYMBOL}\nGroup balance: ${parseFloat(newGBal).toFixed(2)} ${TOKEN_SYMBOL}\nTX: ${EXPLORER_BASE}/tx/${result.txHash}`
        });
      } catch (err: any) {
        await sock.sendMessage(jid, { text: `Contribution failed: ${err.message}` });
      }
      return;
    }

    case '/group_withdraw': {
      if (!groupId) {
        await sock.sendMessage(jid, { text: 'This command only works in group chats.' });
        return;
      }
      const group = await getGroup(groupId);
      if (!group) {
        await sock.sendMessage(jid, { text: 'No group wallet set up.' });
        return;
      }
      if (!isGroupAdmin(group, userId)) {
        await sock.sendMessage(jid, { text: 'Only the group admin can withdraw from the group wallet.' });
        return;
      }
      const gwParts = text.split(/\s+/);
      if (gwParts.length < 3) {
        await sock.sendMessage(jid, { text: 'Usage: /group_withdraw <celo_address> <amount>' });
        return;
      }
      const gwAddr = gwParts[1];
      const gwAmt = parseFloat(gwParts[2]);
      if (!/^0x[0-9a-fA-F]{40}$/.test(gwAddr)) {
        await sock.sendMessage(jid, { text: 'Invalid Celo address.' });
        return;
      }
      if (!gwAmt || !isFinite(gwAmt) || gwAmt <= 0) {
        await sock.sendMessage(jid, { text: 'Invalid amount.' });
        return;
      }
      try {
        await sock.sendMessage(jid, { text: `Withdrawing ${gwAmt.toFixed(2)} ${TOKEN_SYMBOL} from group wallet...` });
        const result = await groupWithdraw(group, gwAmt, gwAddr, walletManager);
        const { balance: newGBal } = await getGroupBalance(group, walletManager);
        await sock.sendMessage(jid, {
          text: `Group withdrawal complete!\n\nAmount: ${gwAmt.toFixed(2)} ${TOKEN_SYMBOL}\nTo: ${gwAddr}\nGroup balance: ${parseFloat(newGBal).toFixed(2)} ${TOKEN_SYMBOL}\nTX: ${EXPLORER_BASE}/tx/${result.txHash}`
        });
      } catch (err: any) {
        await sock.sendMessage(jid, { text: `Group withdrawal failed: ${err.message}` });
      }
      return;
    }

    case '/threshold': {
      if (!groupId) {
        await sock.sendMessage(jid, { text: 'This command only works in group chats.' });
        return;
      }
      const group = await getGroup(groupId);
      if (!group) {
        await sock.sendMessage(jid, { text: 'No group wallet set up. Run /group enable first.' });
        return;
      }
      if (!isGroupAdmin(group, userId)) {
        await sock.sendMessage(jid, { text: 'Only the group admin can change the poll threshold.' });
        return;
      }
      const pct = parseFloat(text.split(/\s+/)[1]);
      if (!pct || pct < 10 || pct > 100) {
        const current = Math.round((group.pollThreshold ?? 0.7) * 100);
        await sock.sendMessage(jid, { text: `Current poll threshold: ${current}%\n\nUsage: /threshold <10-100>\nExample: /threshold 70` });
        return;
      }
      await setPollThreshold(groupId, pct / 100);
      await sock.sendMessage(jid, { text: `Poll threshold updated to ${pct}%. Group spending decisions now require ${pct}% approval.` });
      return;
    }

    case '/vote': {
      if (!groupId) {
        await sock.sendMessage(jid, { text: 'This command only works in group chats.' });
        return;
      }
      const voteParts = text.split(/\s+/);
      const voteChoice = voteParts[1]?.toLowerCase();
      const votePollId = voteParts[2];

      if (!voteChoice || !['yes', 'no'].includes(voteChoice)) {
        // If no poll ID specified, show active polls
        const active = await getActivePolls(groupId);
        if (active.length === 0) {
          await sock.sendMessage(jid, { text: 'No active polls in this group.' });
          return;
        }
        let pollList = 'Active polls:\n\n';
        for (const p of active) {
          pollList += `${p.pollId}\n${p.description}\nAmount: ${p.action.amount.toFixed(2)} cUSD\nVotes: ${p.yesVotes.length} yes / ${p.noVotes.length} no (${Math.round(p.threshold * 100)}% needed)\n\n`;
        }
        pollList += 'Usage: /vote yes <poll_id> or /vote no <poll_id>';
        await sock.sendMessage(jid, { text: pollList });
        return;
      }

      if (!votePollId) {
        // Auto-pick the most recent active poll
        const active = await getActivePolls(groupId);
        if (active.length === 0) {
          await sock.sendMessage(jid, { text: 'No active polls to vote on.' });
          return;
        }
        if (active.length > 1) {
          await sock.sendMessage(jid, { text: `Multiple active polls. Specify which:\n/vote ${voteChoice} <poll_id>\n\nUse /vote to see active polls.` });
          return;
        }
        // Single active poll — vote on it
        const result = await recordPollVote(active[0].pollId, userId, voteChoice as 'yes' | 'no');
        if (!result) {
          await sock.sendMessage(jid, { text: 'Could not record vote. Poll may have ended.' });
          return;
        }
        await handleWhatsAppVoteResult(sock, jid, active[0], result, userId);
        return;
      }

      const poll = await getPollById(votePollId);
      if (!poll || poll.groupId !== groupId) {
        await sock.sendMessage(jid, { text: 'Poll not found in this group.' });
        return;
      }
      if (poll.status !== 'active') {
        await sock.sendMessage(jid, { text: `This poll is already ${poll.status}.` });
        return;
      }
      const result = await recordPollVote(votePollId, userId, voteChoice as 'yes' | 'no');
      if (!result) {
        await sock.sendMessage(jid, { text: 'Could not record vote.' });
        return;
      }
      await handleWhatsAppVoteResult(sock, jid, poll, result, userId);
      return;
    }

    case '/claim': {
      const claimId = text.split(/\s+/)[1];
      if (!claimId) {
        await sock.sendMessage(jid, { text: 'Usage: /claim <claim_id>' });
        return;
      }
      const claim = giftCardClaims.get(claimId);
      if (!claim || Date.now() > claim.expiresAt) {
        if (claim) giftCardClaims.delete(claimId);
        await sock.sendMessage(jid, { text: 'Claim not found or expired.' });
        return;
      }
      if (userId !== claim.recipientUserId) {
        await sock.sendMessage(jid, { text: "This gift card isn't for you." });
        return;
      }
      // Format and send codes
      let codeText = '';
      if (Array.isArray(claim.codes)) {
        codeText = claim.codes.map((c: any) => {
          const parts = [];
          if (c.cardNumber) parts.push(`Card: ${c.cardNumber}`);
          if (c.pinCode) parts.push(`PIN: ${c.pinCode}`);
          return parts.join('\n');
        }).join('\n---\n');
      } else {
        codeText = String(claim.codes);
      }
      await sock.sendMessage(jid, { text: `Your gift card code:\n\n${codeText}` });
      giftCardClaims.delete(claimId);
      return;
    }

    case '/poll': {
      if (!groupId) {
        await sock.sendMessage(jid, { text: 'This command only works in group chats.' });
        return;
      }
      const group = await getGroup(groupId);
      if (!group) {
        await sock.sendMessage(jid, { text: 'No group wallet set up.' });
        return;
      }
      if (!isGroupAdmin(group, userId)) {
        await sock.sendMessage(jid, { text: 'Only the group admin can manage polls.' });
        return;
      }

      const pollParts = text.split(/\s+/);
      const pollSubCmd = pollParts[1]?.toLowerCase();
      const pollIdArg = pollParts[2];

      switch (pollSubCmd) {
        case 'cancel': {
          const targetPollId = pollIdArg || (await getMostRecentActivePoll(groupId))?.pollId;
          if (!targetPollId) {
            await sock.sendMessage(jid, { text: 'No active polls to cancel.' });
            return;
          }
          const closed = await closePoll(targetPollId, 'cancelled');
          if (closed) unpinPollMessage(sock, targetPollId).catch(() => {});
          await sock.sendMessage(jid, { text: closed ? 'Poll cancelled.' : 'Poll not found or already closed.' });
          return;
        }
        case 'approve': {
          const targetPollId = pollIdArg || (await getMostRecentActivePoll(groupId))?.pollId;
          if (!targetPollId) {
            await sock.sendMessage(jid, { text: 'No active polls to approve.' });
            return;
          }
          const closed = await closePoll(targetPollId, 'approved');
          if (closed) unpinPollMessage(sock, targetPollId).catch(() => {});
          const poll = await getPollById(targetPollId);
          if (closed && poll) {
            try {
              const { total, serviceFee } = calculateTotalPayment(poll.action.amount);
              const orderId = generateOrderId();
              await pendingOrders.create({
                orderId,
                telegramId: group.walletId,
                chatId: 0,
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
              });
              await sock.sendMessage(jid, {
                text: `Admin approved: ${poll.description}\nTotal: ${total.toFixed(2)} cUSD (includes 1.5% fee)\n\nReply YES to confirm the group spend, or NO to cancel.`,
              });
            } catch (err: any) {
              await sock.sendMessage(jid, { text: `Poll approved but failed to create order: ${err.message}` });
            }
          } else {
            await sock.sendMessage(jid, { text: 'Poll not found or already closed.' });
          }
          return;
        }
        case 'off': {
          await setPollingEnabled(groupId, false);
          await sock.sendMessage(jid, { text: 'Polling disabled. All group members can now spend directly without polls.' });
          return;
        }
        case 'on': {
          await setPollingEnabled(groupId, true);
          await sock.sendMessage(jid, { text: 'Polling re-enabled. Non-admin spending requests will go to a poll vote.' });
          return;
        }
        default: {
          const active = await getActivePolls(groupId);
          const pollStatus = (group.pollingEnabled ?? true) ? 'ON' : 'OFF';
          if (active.length === 0) {
            await sock.sendMessage(jid, {
              text: `No active polls. Polling is ${pollStatus}.\n\nCommands:\n/poll cancel [poll_id]\n/poll approve [poll_id]\n/poll off — disable polling\n/poll on — enable polling`,
            });
          } else {
            let list = `Active Polls (${active.length}) — Polling: ${pollStatus}\n\n`;
            for (const p of active) {
              list += `${p.pollId}\n${p.description}\n${p.action.amount.toFixed(2)} cUSD | ${p.yesVotes.length} yes / ${p.noVotes.length} no\n\n`;
            }
            list += 'Commands: /poll cancel [id], /poll approve [id]';
            await sock.sendMessage(jid, { text: list });
          }
          return;
        }
      }
    }

    case '/tasks': {
      if (!groupId) {
        await sock.sendMessage(jid, { text: 'This command only works in group chats.' });
        return;
      }
      const group = await getGroup(groupId);
      if (!group || !isGroupAdmin(group, userId)) {
        await sock.sendMessage(jid, { text: 'Admin only.' });
        return;
      }
      // Filter tasks by the admin's userId (WhatsApp doesn't use numeric chatId)
      const [scheduled, recurring] = await Promise.all([
        getUserScheduledTasks(userId),
        getUserRecurringTasks(userId),
      ]);
      if (scheduled.length === 0 && recurring.length === 0) {
        await sock.sendMessage(jid, { text: 'No scheduled or recurring tasks for this group.' });
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
      await sock.sendMessage(jid, { text: msg });
      return;
    }

    case '/task': {
      if (!groupId) {
        await sock.sendMessage(jid, { text: 'This command only works in group chats.' });
        return;
      }
      const group = await getGroup(groupId);
      if (!group || !isGroupAdmin(group, userId)) {
        await sock.sendMessage(jid, { text: 'Admin only.' });
        return;
      }
      const taskParts = text.split(/\s+/);
      const taskSubCmd = taskParts[1]?.toLowerCase();
      if (taskSubCmd !== 'cancel' || !taskParts[2]) {
        await sock.sendMessage(jid, { text: 'Usage: /task cancel <task_id>' });
        return;
      }
      const taskId = taskParts[2];
      const cancelledScheduled = await adminCancelScheduledTask(taskId);
      const cancelledRecurring = !cancelledScheduled ? await adminCancelRecurringTask(taskId) : false;
      if (cancelledScheduled || cancelledRecurring) {
        await sock.sendMessage(jid, { text: `Task ${taskId} cancelled.` });
      } else {
        await sock.sendMessage(jid, { text: 'Task not found or already cancelled/completed.' });
      }
      return;
    }

    case '/help': {
      let helpText = `Toppa — Airtime, Data, Bills & Gift Cards on Celo\n\nCommands:\n/start - Create wallet & get started\n/wallet - Check all token balances\n/withdraw <address> <amount> - Withdraw ${TOKEN_SYMBOL}\n/swap - Convert all tokens to cUSD\n/rate <country> - Check FX rate (e.g. /rate NG)\n/verify - Verify identity (unlock $200/day limit)\n/cancel - Cancel pending order\n/settings - View settings\n/togglereview - Toggle auto-review\n/export - Export private key\n/clear - Clear conversation memory\n/help - Show this message\n`;

      if (groupId) {
        helpText += `\nGroup Commands:\n/group enable - Enable group wallet\n/group - Show group wallet info\n/contribute <amount> - Contribute cUSD to group\n/group_withdraw <addr> <amt> - Admin withdraw\n/threshold <percent> - Set poll approval % (admin)\n/vote - View/vote on active polls\n/poll - Admin: manage polls (cancel/approve/off/on)\n/tasks - Admin: view group scheduled tasks\n/task cancel <id> - Admin: cancel a task\n`;
      }

      helpText += `\n/claim <id> - Claim a gift card sent to you\n`;
      helpText += `\nOr just type what you need:\n"Send 500 NGN airtime to 08012345678"\n"Buy 1GB data for +254712345678"\n"Pay my DSTV subscription"`;
      await sock.sendMessage(jid, { text: helpText });
      return;
    }

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
    // Use the correct wallet for payment: group wallet for group orders, personal wallet otherwise
    const payerWalletId = activeOrder.telegramId.startsWith('group_') ? activeOrder.telegramId : userId;
    const { txHash } = await walletManager.transferToAgent(payerWalletId, activeOrder.totalAmount);
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

    // ── Targeted gift card: store claim for recipient ──
    if (activeOrder.toolName === 'buy_gift_card' && activeOrder.toolArgs?.recipientUserId && result.redeemCodes) {
      const claimId = crypto.randomBytes(4).toString('hex');
      const recipientId = String(activeOrder.toolArgs.recipientUserId);
      giftCardClaims.set(claimId, {
        codes: result.redeemCodes,
        recipientUserId: recipientId,
        orderId: activeOrder.orderId,
        expiresAt: Date.now() + GIFT_CARD_CLAIM_TTL_MS,
      });

      const brand = result.product?.brand?.brandName || 'Gift Card';
      const { balance: newBalance } = await walletManager.getBalance(payerWalletId);
      await sock.sendMessage(jid, {
        text: `✅ Gift Card Purchased!\n\n${brand}\n${activeOrder.totalAmount.toFixed(2)} ${TOKEN_SYMBOL}\nRef: ${result.transactionId}\n\nThis gift card is for ${recipientId}. They can DM me /claim ${claimId} to get their code.\n\nBalance: ${parseFloat(newBalance).toFixed(2)} ${TOKEN_SYMBOL}`,
      });

      // Attempt DM to recipient (only works if they've messaged the bot before)
      try {
        const recipientPhone = recipientId.replace(/^wa_/, '');
        const recipientJid = `${recipientPhone}@s.whatsapp.net`;
        let codeText = '';
        if (Array.isArray(result.redeemCodes)) {
          codeText = result.redeemCodes.map((c: any) => {
            const parts = [];
            if (c.cardNumber) parts.push(`Card: ${c.cardNumber}`);
            if (c.pinCode) parts.push(`PIN: ${c.pinCode}`);
            return parts.join('\n');
          }).join('\n---\n');
        } else {
          codeText = String(result.redeemCodes);
        }
        await sock.sendMessage(recipientJid, {
          text: `You received a gift card! Here's your code:\n\n${codeText}`,
        });
        // DM succeeded — clean up the claim
        giftCardClaims.delete(claimId);
      } catch {
        // DM failed (no prior conversation) — /claim fallback is already in the group message
      }

      // Skip normal completion display
      const userSettings = await userSettingsStore.get(userId);
      if (userSettings.autoReviewEnabled) {
        const userPrivateKey = await walletManager.exportPrivateKey(userId);
        submitAutoReputation({ rating: 100, serviceType: serviceType as any, success: true, userPrivateKey }).catch(() => {});
      }
      return;
    }

    const formattedResult = formatServiceResult(activeOrder.toolName, result, activeOrder);
    const { balance: newBalance } = await walletManager.getBalance(payerWalletId);

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
        const refundResult = await walletManager.refundUser(payerWalletId, activeOrder.totalAmount, paymentTxHash);
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

// ── Poll Helpers ──────────────────────────────────────

/**
 * Create a WhatsApp native poll + our internal tracking poll.
 */
async function sendWhatsAppGroupPoll(sock: any, jid: string, params: {
  groupId: string;
  createdBy: string;
  description: string;
  service: string;
  amount: number;
  details: Record<string, any>;
}): Promise<void> {
  const group = await getGroup(params.groupId);
  if (!group) throw new Error('No group wallet set up.');

  const poll = await createGroupPoll({
    groupId: params.groupId,
    chatId: 0,
    createdBy: params.createdBy,
    description: params.description,
    service: params.service,
    amount: params.amount,
    details: params.details,
    threshold: group.pollThreshold ?? 0.7,
    totalMembers: group.members.length,
  });

  const thresholdPct = Math.round((group.pollThreshold ?? 0.7) * 100);

  // Send native WhatsApp poll
  const sentMsg = await sock.sendMessage(jid, {
    poll: {
      name: `Spend ${params.amount.toFixed(2)} cUSD? ${params.description}`,
      values: ['Yes', 'No'],
      selectableCount: 1,
    },
  });

  // Store the poll message for vote tracking via messages.update
  if (sentMsg?.key?.id && sentMsg.message) {
    pollMessageStore.set(sentMsg.key.id, {
      pollId: poll.pollId,
      groupId: params.groupId,
      message: sentMsg.message,
      messageKey: sentMsg.key,
      jid,
    });

    // Pin the poll in the group (24h, matches poll expiry)
    try {
      await sock.sendMessage(jid, { pin: sentMsg.key, type: 1, time: 86400 });
    } catch (err) {
      // Non-critical — bot may lack pin permissions
    }
  }

  // Send context message with poll ID for /vote fallback
  await sock.sendMessage(jid, {
    text:
      `Poll: ${poll.pollId}\n\n` +
      `${thresholdPct}% approval needed (${Math.ceil(group.members.length * (group.pollThreshold ?? 0.7))} of ${group.members.length} members).\n\n` +
      `Vote on the poll above. You can also use /vote yes or /vote no.\n` +
      `Poll expires in 24 hours.`,
  });
}

/**
 * Handle vote result — send update message and execute if approved.
 */
async function handleWhatsAppVoteResult(
  sock: any, jid: string, poll: any, result: any, _userId: string,
): Promise<void> {
  const thresholdPct = Math.round(result.threshold * 100);

  if (result.status === 'approved') {
    // Unpin the resolved poll
    unpinPollMessage(sock, poll.pollId).catch(() => {});

    await sock.sendMessage(jid, {
      text:
        `Poll approved! ${result.yesCount}/${result.totalMembers} voted yes (${thresholdPct}% needed).\n\n` +
        `Executing: ${poll.description}\n` +
        `Amount: ${poll.action.amount.toFixed(2)} cUSD from group wallet.`,
    });

    // Create a pending order for admin to confirm
    try {
      const group = await getGroup(poll.groupId);
      if (!group) throw new Error('Group not found');

      const { total, serviceFee } = calculateTotalPayment(poll.action.amount);
      const orderId = generateOrderId();

      await pendingOrders.create({
        orderId,
        telegramId: group.walletId,
        chatId: 0,
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
      });

      await sock.sendMessage(jid, {
        text: `Total: ${total.toFixed(2)} cUSD (includes 1.5% fee)\n\nAdmin — reply YES to confirm the group spend, or NO to cancel.`,
      });
    } catch (err: any) {
      await sock.sendMessage(jid, { text: `Poll approved but failed to create order: ${err.message}` });
    }
  } else if (result.status === 'rejected') {
    // Unpin the resolved poll
    unpinPollMessage(sock, poll.pollId).catch(() => {});

    await sock.sendMessage(jid, {
      text: `Poll rejected. Too many "No" votes — ${thresholdPct}% threshold can no longer be reached.`,
    });
  } else {
    await sock.sendMessage(jid, {
      text: `Vote recorded! Current: ${result.yesCount} yes / ${result.noCount} no (need ${thresholdPct}% of ${result.totalMembers})`,
    });
  }
}

// ── JSON Extraction ───────────────────────────────────

function extractJsonByType(response: string, type: string): any {
  try {
    const parsed = JSON.parse(response);
    if (parsed?.type === type) return parsed;
  } catch {
    const idx = response.indexOf(`"${type}"`);
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
              if (extracted?.type === type) return extracted;
            } catch { }
            break;
          }
        }
      }
    }
  }
  return null;
}

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
