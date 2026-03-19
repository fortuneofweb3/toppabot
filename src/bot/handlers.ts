import crypto from 'crypto';
import { tg, TgCallbackQuery } from './tg-client';
import { WalletManager } from '../wallet/manager';
import { PendingOrderStore } from './pending-orders';
import { verifyX402Payment, calculateTotalPayment } from '../blockchain/x402';
import { submitAutoReputation } from '../blockchain/reputation';
import { userSettingsStore } from './user-settings';
import {
  sendAirtime, sendData,
  payBill as payReloadlyBill,
  buyGiftCard, getGiftCardRedeemCode,
} from '../apis/reloadly';
import { createReceipt, updateReceipt, getReceiptByReloadlyId } from '../blockchain/service-receipts';
import { PAYMENT_TOKEN_SYMBOL } from '../blockchain/x402';
import { reservePaymentHash } from '../blockchain/replay-guard';
import { IS_TESTNET, CELO_CAIP2, TOKEN_SYMBOL, EXPLORER_BASE } from '../shared/constants';
import { invalidateReloadlyBalanceCache } from '../shared/balance-cache';
import { sanitizePhone, sanitizeCountryCode, sanitizeAccountNumber } from '../shared/sanitize';

/**
 * Sanitize toolArgs before passing to Reloadly — defense in depth.
 * The LLM generates these from user input and is an untrusted intermediary.
 */
function sanitizeToolArgs(toolName: string, args: Record<string, any>): Record<string, any> {
  const s = { ...args };
  // Sanitize fields common across tools
  if (s.phone != null) s.phone = sanitizePhone(String(s.phone));
  if (s.countryCode != null) s.countryCode = sanitizeCountryCode(String(s.countryCode));
  if (s.accountNumber != null) s.accountNumber = sanitizeAccountNumber(String(s.accountNumber));
  // Validate numeric fields
  if (s.amount != null) {
    s.amount = Number(s.amount);
    if (!isFinite(s.amount) || s.amount <= 0) throw new Error('Invalid amount');
  }
  if (s.operatorId != null) {
    s.operatorId = Number(s.operatorId);
    if (!Number.isInteger(s.operatorId) || s.operatorId <= 0) throw new Error('Invalid operator ID');
  }
  if (s.productId != null) {
    s.productId = Number(s.productId);
    if (!Number.isInteger(s.productId) || s.productId <= 0) throw new Error('Invalid product ID');
  }
  if (s.billerId != null) {
    s.billerId = Number(s.billerId);
    if (!Number.isInteger(s.billerId) || s.billerId <= 0) throw new Error('Invalid biller ID');
  }
  if (s.unitPrice != null) {
    s.unitPrice = Number(s.unitPrice);
    if (!isFinite(s.unitPrice) || s.unitPrice <= 0) throw new Error('Invalid unit price');
  }
  return s;
}

/**
 * Execute a Reloadly service tool by name
 */
async function executeServiceTool(
  toolName: string,
  toolArgs: Record<string, any>,
): Promise<any> {
  const args = sanitizeToolArgs(toolName, toolArgs);

  // Normalize gift card args: LLM sometimes generates toolArgs with `amount` instead
  // of `unitPrice` when it creates order_confirmation directly (bypassing tool short-circuit).
  // Reloadly requires `unitPrice`.
  if (toolName === 'buy_gift_card' && args.unitPrice == null && args.amount != null) {
    args.unitPrice = args.amount;
    delete args.amount;
  }

  switch (toolName) {
    case 'send_airtime':
      return sendAirtime(args as any);
    case 'send_data':
      return sendData(args as any);
    case 'pay_bill':
      return payReloadlyBill(args as any);
    case 'buy_gift_card': {
      const result = await buyGiftCard(args as any);
      // Retry fetching redeem codes — Reloadly may need a few seconds to generate them.
      // This is a read-only GET call (no duplicate purchase risk).
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const codes = await getGiftCardRedeemCode(result.transactionId);
          if (codes && (Array.isArray(codes) ? codes.length > 0 : true)) {
            return { ...result, redeemCodes: codes };
          }
        } catch (err: any) {
          console.warn(`[GiftCard] Code fetch attempt ${attempt + 1}/5 failed:`, err.message);
        }
        if (attempt < 4) await new Promise(r => setTimeout(r, 3000));
      }
      // Codes still not ready after retries — return without them.
      // User can ask the agent later: "get code for transaction <id>"
      return { ...result, redeemCodesNote: 'Codes are being generated. Ask me for the code in a minute.' };
    }
    default:
      throw new Error(`Unknown service: ${toolName}`);
  }
}

/**
 * Format the result of a service execution for display
 */
function formatServiceResult(toolName: string, result: any, order?: { toolArgs?: Record<string, any>; totalAmount?: number }): string {
  switch (toolName) {
    case 'send_airtime':
    case 'send_data': {
      const phone = order?.toolArgs?.phone || order?.toolArgs?.recipientPhone || '';
      const cUSD = order?.totalAmount;
      const localAmt = result.deliveredAmount;
      const localCur = result.deliveredAmountCurrencyCode || '';

      let text = `${result.operatorName || 'Operator'}\n`;
      if (phone) text += `${phone}\n`;
      if (cUSD != null && localAmt && localCur) {
        text += `${cUSD.toFixed(2)} cUSD (${localAmt} ${localCur})\n`;
      } else if (cUSD != null) {
        text += `${cUSD.toFixed(2)} cUSD\n`;
      } else if (localAmt) {
        text += `${localAmt} ${localCur}\n`;
      }
      text += `Ref: ${result.transactionId}`;
      if (result.pinDetail) {
        text += `\n\nPIN: ${result.pinDetail.code}`;
        if (result.pinDetail.ivr) text += `\nDial: ${result.pinDetail.ivr}`;
        if (result.pinDetail.validity) text += `\nValid: ${result.pinDetail.validity}`;
        if (result.pinDetail.info1) text += `\n${result.pinDetail.info1}`;
      }
      return text;
    }
    case 'pay_bill': {
      const cUSD = order?.totalAmount;
      const acct = order?.toolArgs?.accountNumber || order?.toolArgs?.subscriberAccountNumber || '';
      let text = '';
      if (acct) text += `Account: ${acct}\n`;
      if (cUSD != null) text += `${cUSD.toFixed(2)} cUSD\n`;
      text += `Ref: ${result.referenceId || result.id}`;
      if (result.message) text += `\n${result.message}`;
      return text;
    }
    case 'buy_gift_card': {
      const cUSD = order?.totalAmount;
      const brand = result.product?.brand?.brandName || 'Gift Card';
      let text = `${brand}\n`;
      if (cUSD != null) {
        text += `${cUSD.toFixed(2)} cUSD`;
        if (result.amount && result.currencyCode && result.currencyCode !== 'USD') {
          text += ` (${result.amount} ${result.currencyCode})`;
        }
        text += '\n';
      } else if (result.amount) {
        text += `${result.amount} ${result.currencyCode || ''}\n`;
      }
      text += `Ref: ${result.transactionId}`;
      if (result.redeemCodes) {
        if (Array.isArray(result.redeemCodes)) {
          const codes = result.redeemCodes.map((c: any) => {
            const parts = [];
            if (c.cardNumber) parts.push(`Card: ${c.cardNumber}`);
            if (c.pinCode) parts.push(`PIN: ${c.pinCode}`);
            return parts.length > 0 ? parts.join('\n') : JSON.stringify(c);
          }).join('\n---\n');
          text += `\n\nRedeem Code(s):\n${codes}`;
        } else {
          text += `\n\nRedeem Code: ${result.redeemCodes}`;
        }
      } else if (result.redeemCodesNote) {
        text += `\n\n${result.redeemCodesNote}`;
      }
      return text;
    }
    default:
      return JSON.stringify(result, null, 2);
  }
}

// Track in-progress withdrawals and payments to prevent concurrent wallet operations.
// If a payment is processing, withdrawals are blocked (and vice versa).
// This prevents the race where both pass the balance check but only one can succeed on-chain.
// Locks auto-expire after 2 minutes to prevent stuck locks from blocking users permanently.
const WALLET_OP_TIMEOUT_MS = 2 * 60 * 1000;
const withdrawalsInProgress = new Set<string>();
const walletOpsInProgress = new Map<string, number>(); // telegramId → timestamp

function acquireWalletLock(userId: string): boolean {
  const existing = walletOpsInProgress.get(userId);
  if (existing && Date.now() - existing < WALLET_OP_TIMEOUT_MS) {
    return false; // Lock held and not expired
  }
  if (existing) {
    console.warn(`[WalletLock] Expired lock for user ${userId} — releasing stale lock`);
  }
  walletOpsInProgress.set(userId, Date.now());
  return true;
}

function releaseWalletLock(userId: string): void {
  walletOpsInProgress.delete(userId);
}

// Pending withdrawal storage — keeps callback_data under Telegram's 64-byte limit.
// Instead of encoding userId + amount + address in the callback string (always >64 bytes),
// we store them here keyed by a short random ID.
const WITHDRAWAL_TTL_MS = 10 * 60 * 1000;
const pendingWithdrawals = new Map<string, { userId: string; amount: number; toAddress: string; expiresAt: number }>();

export function storePendingWithdrawal(userId: string, amount: number, toAddress: string): string {
  const now = Date.now();
  for (const [id, wd] of pendingWithdrawals) {
    if (now > wd.expiresAt) pendingWithdrawals.delete(id);
  }
  const wdId = crypto.randomBytes(4).toString('hex');
  pendingWithdrawals.set(wdId, { userId, amount, toAddress, expiresAt: now + WITHDRAWAL_TTL_MS });
  return wdId;
}

// Quick action button prompts
const quickActions: Record<string, string> = {
  quick_airtime: 'What country and phone number should I send airtime to?',
  quick_data: 'What country and phone number should I send data to?',
  quick_bill: 'What country and bill type do you want to pay?',
  quick_giftcard: 'What brand and amount for the gift card?',
};

/**
 * Route a callback query to the correct handler.
 * Direct pattern matching — no framework.
 */
export async function handleCallback(
  query: TgCallbackQuery,
  walletManager: WalletManager,
  pendingOrders: PendingOrderStore,
  recordSpending: (userId: string, amount: number) => void,
): Promise<void> {
  const data = query.data || '';
  if (!data || data.length > 64) return; // Reject empty or oversized callback data (Telegram limit: 64 bytes)
  const userId = query.from.id.toString();
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  let match: RegExpMatchArray | null;

  // Helpers — shorthand for common operations on the callback's message
  const editMsg = (text: string, opts?: { parse_mode?: string; reply_markup?: any }) =>
    chatId && messageId
      ? tg('editMessageText', { chat_id: chatId, message_id: messageId, text, ...opts })
      : Promise.resolve();

  const answer = (text?: string, showAlert = false) =>
    tg('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: showAlert });

  const sendMsg = (text: string, opts?: { parse_mode?: string; reply_markup?: any }) =>
    chatId ? tg('sendMessage', { chat_id: chatId, text, ...opts }) : Promise.resolve();

  try {
    // ─── Quick Actions ───────────────────────────
    if (quickActions[data]) {
      await answer();
      await sendMsg(quickActions[data]);
      return;
    }

    // ─── Order Confirmation ──────────────────────
    if ((match = data.match(/^order_confirm_(order_\d{13}_[a-z0-9]{6,8})$/))) {
      const orderId = match[1];

      if (!userId) { await answer('Session error. Please try again.'); return; }

      const order = await pendingOrders.atomicTransition(orderId, 'pending_confirmation', 'pending_payment');
      if (!order) { await answer('Order expired or already confirmed.'); return; }

      if (order.telegramId !== userId) {
        await pendingOrders.updateStatus(orderId, 'pending_confirmation');
        await answer('Unauthorized.');
        return;
      }

      const { balance } = await walletManager.getBalance(order.telegramId);
      const balanceNum = parseFloat(balance);
      const GAS_RESERVE = 0.01; // Reserve for cUSD gas fees
      const usableBalance = balanceNum - GAS_RESERVE;

      if (usableBalance < order.totalAmount) {
        await pendingOrders.updateStatus(orderId, 'pending_confirmation');
        const address = await walletManager.getAddress(order.telegramId);
        const shortage = order.totalAmount - usableBalance;
        await editMsg(
          `❌ Insufficient Balance\n\n` +
          `Required: ${order.totalAmount.toFixed(2)} ${TOKEN_SYMBOL}\n` +
          `Available: ${usableBalance > 0 ? usableBalance.toFixed(2) : '0.00'} ${TOKEN_SYMBOL} (after gas)\n` +
          `Short by: ${shortage.toFixed(2)} ${TOKEN_SYMBOL}\n\n` +
          `Deposit ${TOKEN_SYMBOL} to:\n\`${address}\``,
          { parse_mode: 'Markdown' },
        );
        await answer('Insufficient balance');
        return;
      }

      const balanceRounded = parseFloat(balance).toFixed(2);
      const remaining = (balanceNum - order.totalAmount).toFixed(2);
      await editMsg(
        `Payment Request\n\n` +
        `${order.totalAmount.toFixed(2)} ${TOKEN_SYMBOL} from your wallet\n` +
        `(+ ~$0.001 gas fee)\n\n` +
        `Balance: ${balanceRounded} ${TOKEN_SYMBOL}\n` +
        `Remaining: ~${remaining} ${TOKEN_SYMBOL}`,
        {
          reply_markup: { inline_keyboard: [
            [{ text: 'Accept Payment', callback_data: `pay_accept_${orderId}` }],
            [{ text: 'Decline', callback_data: `pay_decline_${orderId}` }],
          ]},
        },
      );
      await answer();
      return;
    }

    // ─── Order Cancel ────────────────────────────
    if ((match = data.match(/^order_cancel_(order_\d{13}_[a-z0-9]{6,8})$/))) {
      const orderId = match[1];

      // Check ownership BEFORE transitioning state to avoid group chat race
      const existing = await pendingOrders.get(orderId);
      if (!existing || (existing.status !== 'pending_confirmation' && existing.status !== 'pending_payment')) {
        await answer('Order already cancelled or expired.');
        return;
      }
      if (existing.telegramId !== userId) {
        await answer('Unauthorized.');
        return;
      }

      const order = await pendingOrders.atomicTransition(
        orderId, ['pending_confirmation', 'pending_payment'], 'cancelled',
      );
      if (!order) { await answer('Order already cancelled or expired.'); return; }

      await editMsg('Order cancelled.');
      await answer();
      return;
    }

    // ─── Payment Accept (Core Execution Path) ────
    if ((match = data.match(/^pay_accept_(order_\d{13}_[a-z0-9]{6,8})$/))) {
      const orderId = match[1];

      if (!userId) { await answer('Session error. Please try again.'); return; }

      const order = await pendingOrders.atomicTransition(orderId, 'pending_payment', 'processing');
      if (!order) { await answer('Order expired or already processing.'); return; }

      if (order.telegramId !== userId) {
        await pendingOrders.updateStatus(orderId, 'pending_payment');
        await answer('Unauthorized.');
        return;
      }

      // Prevent concurrent wallet operations (payment + withdrawal race)
      if (!acquireWalletLock(userId)) {
        await pendingOrders.updateStatus(orderId, 'pending_payment');
        await answer('Another transaction is processing. Please wait.');
        return;
      }

      await editMsg('⏳ Processing payment... (1/4)');
      await answer();

      let receiptId = '';
      let paymentTxHash = ''; // Track whether cUSD was transferred (for refund on service failure)
      let serviceSucceeded = false; // V2 guard: only refund if Reloadly call itself failed
      try {
        const { balance: currentBalance, address: userWalletAddress } = await walletManager.getBalance(order.telegramId);
        const usableBal = parseFloat(currentBalance) - 0.01; // gas reserve
        if (usableBal < order.totalAmount) {
          await pendingOrders.updateStatus(orderId, 'failed', { error: 'Balance dropped below required amount' });
          const address = await walletManager.getAddress(order.telegramId);
          await editMsg(
            `❌ Insufficient Balance\n\n` +
            `Your balance dropped to ${usableBal > 0 ? usableBal.toFixed(2) : '0.00'} ${TOKEN_SYMBOL} (after gas) since confirmation.\n` +
            `Required: ${order.totalAmount.toFixed(2)} ${TOKEN_SYMBOL}\n\n` +
            `Deposit ${TOKEN_SYMBOL} to:\n${address}`,
          );
          return;
        }

        await editMsg('⏳ Transferring cUSD... (2/4)');
        const { txHash } = await walletManager.transferToAgent(order.telegramId, order.totalAmount);
        paymentTxHash = txHash; // Mark payment as sent — refund if service fails

        await editMsg('⏳ Verifying on-chain... (3/4)');
        const isReserved = await reservePaymentHash(txHash, 'telegram');
        if (!isReserved) throw new Error('Payment hash already used. This should not happen — contact support.');

        const verification = await verifyX402Payment(txHash, order.totalAmount);
        if (!verification.verified) throw new Error(`Payment verification failed: ${verification.error}`);

        const serviceType = order.action === 'airtime' ? 'airtime' :
                            order.action === 'data' ? 'data' :
                            order.action === 'bill' ? 'bill_payment' :
                            'gift_card' as const;
        receiptId = await createReceipt({
          paymentTxHash: txHash,
          payer: userWalletAddress,
          paymentAmount: order.totalAmount.toString(),
          paymentToken: PAYMENT_TOKEN_SYMBOL,
          paymentNetwork: CELO_CAIP2,
          serviceType,
          source: 'telegram',
          serviceArgs: { toolName: order.toolName, ...order.toolArgs },
        });

        // Pre-execution check: if the staleness guard already marked this order failed
        // (e.g. server was slow, user sent a new message after 3 min), abort before calling
        // Reloadly to prevent double-purchases. Payment was already sent on-chain so it will
        // be refunded in the catch block below (paymentTxHash is set, serviceSucceeded is false).
        const freshOrder = await pendingOrders.get(orderId);
        if (!freshOrder || freshOrder.status !== 'processing') {
          throw new Error('Order was cancelled or timed out before service execution');
        }

        const actionLabel = order.action === 'airtime' ? 'Sending airtime' :
                            order.action === 'data' ? 'Activating data plan' :
                            order.action === 'bill' ? 'Paying bill' :
                            'Purchasing gift card';
        await editMsg(`⏳ ${actionLabel}... (4/4)`);
        const result = await executeServiceTool(order.toolName, order.toolArgs);
        // V2 guard: Reloadly service call completed — do NOT refund on bookkeeping errors below
        serviceSucceeded = true;

        await updateReceipt(receiptId, {
          status: 'success',
          reloadlyTransactionId: result.transactionId,
          reloadlyStatus: result.status,
          serviceResult: { toolName: order.toolName },
        });

        recordSpending(order.telegramId, order.totalAmount);
        invalidateReloadlyBalanceCache();

        const userSettings = await userSettingsStore.get(order.telegramId);

        if (userSettings.autoReviewEnabled) {
          try {
            const userPrivateKey = await walletManager.exportPrivateKey(order.telegramId);
            const svcType = order.action === 'airtime' ? 'airtime' :
                            order.action === 'data' ? 'data' :
                            order.action === 'bill' ? 'bill_payment' : 'gift_card';
            await submitAutoReputation({ rating: 100, serviceType: svcType, success: true, userPrivateKey });
            console.log(`[Auto-Review] User ${order.telegramId} auto-rated 100/100 (5★) for ${svcType}`);
          } catch (error: any) {
            console.error('[Auto-Review Error]', error.message);
          }
        }

        await pendingOrders.updateStatus(orderId, 'completed', { txHash, result });
        const { balance: newBalance } = await walletManager.getBalance(order.telegramId);
        const explorerUrl = `${EXPLORER_BASE}/tx/${txHash}`;

        const balanceRounded = parseFloat(newBalance).toFixed(2);
        const actionTitle = order.action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const completionText =
          `✅ ${actionTitle} Complete!\n\n` +
          `${formatServiceResult(order.toolName, result, order)}\n\n` +
          `Balance: ${balanceRounded} ${TOKEN_SYMBOL}`;

        // Gift card codes not ready — add a "Get Code" retry button
        const gcCodesDelayed = order.toolName === 'buy_gift_card' && result.redeemCodesNote && result.transactionId;

        if (userSettings.autoReviewEnabled) {
          const buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
            [{ text: '🔍 View Payment on Celoscan', url: explorerUrl }],
          ];
          if (gcCodesDelayed) {
            buttons.push([{ text: '🎁 Get Redeem Code', callback_data: `gc_code_${result.transactionId}` }]);
          }
          await editMsg(completionText, { reply_markup: { inline_keyboard: buttons } });
        } else {
          const extraText = gcCodesDelayed ? '\n\nTap "Get Redeem Code" below when ready.' : '\n\n⭐ How was your experience?';
          await editMsg(completionText + extraText);

          const ratingButtons: Array<Array<{ text: string; callback_data: string }>> = [
            [
              { text: '⭐', callback_data: `rate_${orderId}_1` },
              { text: '⭐⭐', callback_data: `rate_${orderId}_2` },
              { text: '⭐⭐⭐', callback_data: `rate_${orderId}_3` },
            ],
            [
              { text: '⭐⭐⭐⭐', callback_data: `rate_${orderId}_4` },
              { text: '⭐⭐⭐⭐⭐', callback_data: `rate_${orderId}_5` },
            ],
            [{ text: 'Skip', callback_data: `rate_${orderId}_skip` }],
          ];
          if (gcCodesDelayed) {
            ratingButtons.unshift([{ text: '🎁 Get Redeem Code', callback_data: `gc_code_${result.transactionId}` }]);
          }
          await sendMsg('Rate this service:', {
            reply_markup: { inline_keyboard: ratingButtons },
          });
        }
      } catch (error: any) {
        console.error('[Payment Execute Error]', { orderId, userId: order.telegramId, error: error.message });

        if (receiptId) await updateReceipt(receiptId, { status: 'failed', error: error.message });
        await pendingOrders.updateStatus(orderId, 'failed', { error: error.message });

        // Auto-refund ONLY if the Reloadly service call itself failed.
        // If service succeeded but bookkeeping (updateReceipt) threw, do NOT refund.
        let refunded = false;
        if (paymentTxHash && !serviceSucceeded) {
          try {
            const refundResult = await walletManager.refundUser(order.telegramId, order.totalAmount, paymentTxHash);
            console.log(`[Auto-Refund] ${order.totalAmount} cUSD refunded to user ${order.telegramId} | tx: ${refundResult.txHash}`);
            if (receiptId) await updateReceipt(receiptId, { refundTxHash: refundResult.txHash });
            refunded = true;
          } catch (refundErr: any) {
            console.error('[Auto-Refund FAILED]', { orderId, userId: order.telegramId, error: refundErr.message });
          }
        }

        // Categorize errors — never expose raw error.message to users
        let userMsg: string;
        const errMsg = error.message || '';
        if (errMsg.includes('Insufficient balance') || errMsg.includes('Insufficient cUSD') || errMsg.includes('transfer amount exceeds balance')) {
          userMsg = `You don't have enough ${TOKEN_SYMBOL} to complete this payment. Deposit more to your wallet via /wallet.`;
        } else if (errMsg.includes('verification') || errMsg.includes('INVALID')) {
          userMsg = 'Payment verification failed. Please try again.';
        } else if (errMsg.includes('operator') || errMsg.includes('OPERATOR')) {
          userMsg = 'Service provider error. Please check your details and try again.';
        } else if (errMsg.includes('amount') || errMsg.includes('AMOUNT') || errMsg.includes('minimum') || errMsg.includes('maximum') || errMsg.includes('denomination')) {
          userMsg = 'The amount is not accepted by the provider. Try a different amount — use /start to see available plans.';
        } else {
          userMsg = 'Transaction failed. Please try again or contact support.';
        }

        if (refunded) {
          userMsg += `\n\n${order.totalAmount.toFixed(2)} ${TOKEN_SYMBOL} has been refunded to your wallet.`;
        } else if (paymentTxHash && !serviceSucceeded) {
          userMsg += `\n\nYour payment is being reviewed for a refund. Contact support if not resolved.`;
        }

        await editMsg(`❌ Transaction Failed\n\n${userMsg}`);
      } finally {
        releaseWalletLock(userId);
      }
      return;
    }

    // ─── Payment Decline ─────────────────────────
    if ((match = data.match(/^pay_decline_(order_\d{13}_[a-z0-9]{6,8})$/))) {
      const orderId = match[1];

      // Check ownership BEFORE transitioning state to avoid group chat race
      const existing = await pendingOrders.get(orderId);
      if (!existing || existing.status !== 'pending_payment') {
        await answer('Order expired or already processed.');
        return;
      }
      if (existing.telegramId !== userId) {
        await answer('Unauthorized.');
        return;
      }

      await pendingOrders.atomicTransition(orderId, 'pending_payment', 'cancelled');
      await editMsg('Payment declined. Order cancelled.');
      await answer();
      return;
    }

    // ─── Gift Card Code Retrieval ──────────────────
    if ((match = data.match(/^gc_code_(\d+)$/))) {
      if (!userId) { await answer('Session error. Please try again.'); return; }
      const transactionId = parseInt(match[1], 10);

      // Ownership check: verify this user bought this gift card
      const receipt = await getReceiptByReloadlyId(transactionId);
      if (!receipt || receipt.serviceType !== 'gift_card') {
        await answer('Gift card purchase not found.', true);
        return;
      }

      // Verify the Telegram user's wallet matches the receipt payer.
      // Deny if payer is 'unknown' or doesn't match — never skip ownership check.
      if (userId) {
        const userAddress = await walletManager.getAddress(userId);
        if (!userAddress || receipt.payer === 'unknown' || receipt.payer.toLowerCase() !== userAddress.toLowerCase()) {
          await answer('Unauthorized.', true);
          return;
        }
      }

      await answer();
      try {
        const codes = await getGiftCardRedeemCode(transactionId);
        if (codes && Array.isArray(codes) && codes.length > 0) {
          const formatted = codes.map((c: any) => {
            const parts = [];
            if (c.cardNumber) parts.push(`Card: ${c.cardNumber}`);
            if (c.pinCode) parts.push(`PIN: ${c.pinCode}`);
            return parts.length > 0 ? parts.join('\n') : JSON.stringify(c);
          }).join('\n---\n');
          await sendMsg(`🎁 Redeem Code(s):\n\n${formatted}`);
        } else {
          console.warn(`[GiftCard] No codes returned for txn ${transactionId} — codes:`, JSON.stringify(codes));
          await sendMsg('Codes are still being generated. Try again in a minute.');
        }
      } catch (err: any) {
        console.error(`[GiftCard] Code fetch failed for txn ${transactionId}:`, err.message);
        await sendMsg('Could not fetch codes yet. Try again in a minute.');
      }
      return;
    }

    // ─── Export Warning (2-step key export) ───────
    if ((match = data.match(/^export_warning_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }
      if (query.message?.chat.type !== 'private') {
        await answer('Use this in a private chat for security.', true);
        return;
      }

      await editMsg(
        `⚠️ Export Private Key\n\n` +
        `This will reveal your wallet's private key.\n` +
        `Anyone with this key has full control of your wallet.\n\n` +
        `Only continue if you understand the risks.`,
        {
          reply_markup: { inline_keyboard: [
            [{ text: 'Yes, show my key', callback_data: `export_confirm_${userId}` }],
            [{ text: 'Cancel', callback_data: `export_cancel_${userId}` }],
          ]},
        },
      );
      await answer();
      return;
    }

    // ─── Export Confirm ──────────────────────────
    if ((match = data.match(/^export_confirm_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }
      try {
        const privateKey = await walletManager.exportPrivateKey(userId);
        await editMsg(
          `Your Private Key (save it securely, then delete this message):\n\n` +
          `${privateKey}\n\n` +
          `WARNING: Anyone with this key controls your wallet. Never share it.`,
        );
      } catch (error: any) {
        console.error('[Export Error]', error.message);
        await editMsg('❌ Failed to export private key. Please try again.');
      }
      await answer();
      return;
    }

    // ─── Export Cancel ───────────────────────────
    if ((match = data.match(/^export_cancel_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }
      await editMsg('Private key export cancelled.');
      await answer();
      return;
    }

    // ─── Withdraw Confirm ────────────────────────
    if ((match = data.match(/^wd_([a-f0-9]{8})$/))) {
      if (!userId) { await answer('Session error. Please try again.'); return; }
      const wd = pendingWithdrawals.get(match[1]);
      if (!wd || Date.now() > wd.expiresAt) {
        pendingWithdrawals.delete(match[1]);
        await answer('Withdrawal expired. Please use /withdraw again.');
        return;
      }
      if (userId !== wd.userId) { await answer('Unauthorized'); return; }
      pendingWithdrawals.delete(match[1]);
      const { amount, toAddress } = wd;

      const withdrawKey = `${userId}_${amount}_${toAddress}`;
      if (withdrawalsInProgress.has(withdrawKey)) { await answer('Withdrawal already processing.'); return; }
      if (!acquireWalletLock(userId)) { await answer('A payment is processing. Please wait.'); return; }
      withdrawalsInProgress.add(withdrawKey);

      try {
        await editMsg('⏳ Processing withdrawal...');
        await answer();

        // Re-check balance after acquiring lock (could have changed since confirmation)
        const { balance: currentBalance } = await walletManager.getBalance(userId);
        if (parseFloat(currentBalance) < amount) {
          await editMsg(
            `❌ Insufficient Balance\n\n` +
            `Your balance dropped to ${parseFloat(currentBalance).toFixed(2)} ${TOKEN_SYMBOL}.\n` +
            `Required: ${amount.toFixed(2)} ${TOKEN_SYMBOL}`,
          );
          return;
        }

        const result = await walletManager.withdraw(userId, toAddress, amount);
        const { balance: newBalance } = await walletManager.getBalance(userId);
        const explorerUrl = `${EXPLORER_BASE}/tx/${result.txHash}`;

        await editMsg(
          `✅ Withdrawal Complete!\n\n` +
          `Sent: ${parseFloat(result.amount).toFixed(2)} ${TOKEN_SYMBOL}\n` +
          `To: \`${result.to}\`\n\n` +
          `Balance: ${parseFloat(newBalance).toFixed(2)} ${TOKEN_SYMBOL}`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '🔍 View on Celoscan', url: explorerUrl }],
            ]},
          },
        );
      } catch (error: any) {
        console.error('[Withdraw Error]', error.message);
        const msg = error.message.includes('Insufficient') ? 'Insufficient balance for withdrawal.' : 'Withdrawal failed. Please try again.';
        await editMsg(`❌ ${msg}`);
      } finally {
        withdrawalsInProgress.delete(withdrawKey);
        releaseWalletLock(userId);
      }
      return;
    }

    // ─── Withdraw Cancel ─────────────────────────
    if ((match = data.match(/^wdc_([a-f0-9]{8})$/))) {
      const wd = pendingWithdrawals.get(match[1]);
      if (wd && wd.userId !== userId) {
        await answer('Unauthorized.');
        return;
      }
      pendingWithdrawals.delete(match[1]);
      await editMsg('Withdrawal cancelled.');
      await answer();
      return;
    }

    // ─── Balance ─────────────────────────────────
    if ((match = data.match(/^balance_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }

      try {
        const { balance, address } = await walletManager.getBalance(userId);
        const explorerUrl = `${EXPLORER_BASE}/address/${address}`;

        await editMsg(
          `💰 Your Wallet\n\nBalance: ${parseFloat(balance).toFixed(2)} ${TOKEN_SYMBOL}\n\nAddress:\n\`${address}\``,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '🔍 View on Celoscan', url: explorerUrl }],
              [{ text: '🔄 Refresh Balance', callback_data: `balance_${userId}` }],
            ]},
          },
        );
      } catch (error: any) {
        console.error('[Balance Error]', error.message);
        await editMsg('❌ Could not fetch balance. Please try again.');
      }
      await answer();
      return;
    }

    // ─── History ─────────────────────────────────
    if ((match = data.match(/^history_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }
      await editMsg(
        `📊 Transaction History\n\n` +
        `Coming soon: View your recent airtime, data, bills, and gift card purchases.\n\n` +
        `For now, check your wallet address on Celoscan.`,
      );
      await answer();
      return;
    }

    // ─── Settings Close ──────────────────────────
    if ((match = data.match(/^settings_close_(\d+)$/))) {
      if (chatId && messageId) await tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
      await answer('Closed');
      return;
    }

    // ─── Toggle Auto-Review ──────────────────────
    if ((match = data.match(/^toggle_autoreview_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }

      const newStatus = await userSettingsStore.toggleAutoReview(userId);
      const statusText = newStatus ? 'ON ✅' : 'OFF ❌';

      await editMsg(
        `⚙️ Wallet Settings\n\nChoose an option:`,
        {
          reply_markup: { inline_keyboard: [
            [{ text: `⭐ Auto-Review: ${statusText}`, callback_data: `toggle_autoreview_${userId}` }],
            [{ text: '🔑 Export Private Key', callback_data: `export_warning_${userId}` }],
            [{ text: '📊 Transaction History', callback_data: `history_${userId}` }],
            [{ text: '💰 Check Balance', callback_data: `balance_${userId}` }],
            [{ text: '❌ Close', callback_data: `settings_close_${userId}` }],
          ]},
        },
      );
      await answer(
        newStatus
          ? '⭐ Auto-review enabled: You\'ll automatically give 5★ after each service'
          : '⭐ Auto-review disabled: You\'ll be asked to rate after each service',
        true,
      );
      return;
    }

    // ─── Star Rating ─────────────────────────────
    if ((match = data.match(/^rate_(order_\d{13}_[a-z0-9]{6,8})_(\d+|skip)$/))) {
      const orderId = match[1];
      const ratingStr = match[2];

      const order = await pendingOrders.get(orderId);
      if (!order || order.telegramId !== userId) { await answer('Order expired or not found.'); return; }
      if (order.status !== 'completed') { await answer('Order not completed yet.'); return; }

      if (chatId && messageId) await tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});

      if (ratingStr === 'skip') { await answer('Skipped rating'); return; }

      const stars = parseInt(ratingStr);
      if (stars < 1 || stars > 5) { await answer('Invalid rating'); return; }

      await answer(`${stars} star${stars > 1 ? 's' : ''}`);
      await sendMsg(`Thanks for rating ${stars}⭐!`);

      try {
        const userPrivateKey = await walletManager.exportPrivateKey(userId);
        const serviceType = order.action === 'airtime' ? 'airtime' :
                           order.action === 'data' ? 'data' :
                           order.action === 'bill' ? 'bill_payment' : 'gift_card';
        await submitAutoReputation({ rating: stars * 20, serviceType, success: true, userPrivateKey });
        console.log(`[Manual-Review] User ${userId} rated ${stars * 20}/100 (${stars}★) for ${serviceType}`);
      } catch (error: any) {
        console.error('[Manual-Review Error]', error.message);
      }
      return;
    }

  } catch (error: any) {
    console.error('[Callback Handler Error]', { data, error: error.message });
    tg('answerCallbackQuery', { callback_query_id: query.id, text: 'An error occurred.' }).catch(() => {});
  }
}
