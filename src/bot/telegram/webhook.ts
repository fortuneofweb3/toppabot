/**
 * Prestmit Webhook Handler — Processes gift card sell notifications.
 *
 * Events handled:
 *   - giftcard-trade.sell.approved → auto-credit cUSD to user wallet
 *   - giftcard-trade.sell.rejected → notify user
 *
 * Signature verification: HMAC SHA-256 of raw body, Base64 encoded.
 * Header: x-prestmit-signature
 */

import crypto from 'crypto';
import { tg } from './client';
import { ngnToCusd } from '../../apis/prestmit';
import {
  getSellOrderByIdentifier,
  markApproved,
  markRejected,
  markCredited,
  markFailed,
} from '../sell-orders';
import { refundPayer } from '../../shared/refund';
import { createReceipt, updateReceipt } from '../../blockchain/service-receipts';
import { CELO_CAIP2 } from '../../shared/constants';

const WEBHOOK_SECRET = process.env.PRESTMIT_WEBHOOK_SECRET;

// ─── Signature Verification ──────────────────────────────────

function verifySignature(rawBody: Buffer, signature: string): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn('[Prestmit Webhook] PRESTMIT_WEBHOOK_SECRET not set — rejecting webhook');
    return false;
  }

  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}

// ─── Webhook Types ───────────────────────────────────────────

interface PrestmitWebhookPayload {
  data: {
    id: number;
    amount: string;
    status: string;
    wallet?: string;
    createdAt: string;
    balanceAfter?: number | null;
    balanceBefore?: number | null;
    transactionSource?: string;
    partnersApiIdentifier?: string;   // Our uniqueIdentifier
    rejectReason?: string;
    reference?: string;
  };
  event: string;
  accountID: number;
}

// ─── Main Handler ────────────────────────────────────────────

/**
 * Process a Prestmit webhook payload.
 * Called from the Express route with raw body for signature verification.
 */
export async function handlePrestmitWebhook(rawBody: Buffer): Promise<void> {
  // Parse payload
  let payload: PrestmitWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    console.error('[Prestmit Webhook] Invalid JSON payload');
    return;
  }

  console.log(`[Prestmit Webhook] Event: ${payload.event} | ID: ${payload.data?.id}`);

  // Route by event type
  switch (payload.event) {
    case 'giftcard-trade.sell.approved':
      await handleSellApproved(payload);
      break;

    case 'giftcard-trade.sell.rejected':
      await handleSellRejected(payload);
      break;

    default:
      console.log(`[Prestmit Webhook] Unhandled event: ${payload.event}`);
  }
}

// ─── Sell Approved ───────────────────────────────────────────

async function handleSellApproved(payload: PrestmitWebhookPayload): Promise<void> {
  const { data } = payload;
  const identifier = data.partnersApiIdentifier;

  if (!identifier) {
    console.warn('[Prestmit Webhook] Approved event missing partnersApiIdentifier');
    return;
  }

  // Look up our sell order
  const order = await getSellOrderByIdentifier(identifier);
  if (!order) {
    console.warn(`[Prestmit Webhook] No sell order found for identifier: ${identifier}`);
    return;
  }

  // Idempotency: skip if already processed
  if (order.status !== 'pending') {
    console.log(`[Prestmit Webhook] Order ${order.orderId} already ${order.status} — skipping`);
    return;
  }

  const payoutAmount = parseFloat(data.amount) || order.payoutAmountLocal;

  // Mark as approved
  const approved = await markApproved(order.orderId, payoutAmount);
  if (!approved) {
    console.warn(`[Prestmit Webhook] Failed to mark ${order.orderId} as approved (race?)`);
    return;
  }

  // Auto-credit: convert NGN payout to cUSD and send to user
  await creditUser(order.orderId, order.userId, order.chatId, payoutAmount, order.cardName);
}

// ─── Sell Rejected ───────────────────────────────────────────

async function handleSellRejected(payload: PrestmitWebhookPayload): Promise<void> {
  const { data } = payload;
  const identifier = data.partnersApiIdentifier;

  if (!identifier) {
    console.warn('[Prestmit Webhook] Rejected event missing partnersApiIdentifier');
    return;
  }

  const order = await getSellOrderByIdentifier(identifier);
  if (!order) {
    console.warn(`[Prestmit Webhook] No sell order found for identifier: ${identifier}`);
    return;
  }

  if (order.status !== 'pending') {
    console.log(`[Prestmit Webhook] Order ${order.orderId} already ${order.status} — skipping`);
    return;
  }

  const reason = data.rejectReason || 'Card declined by Prestmit';
  await markRejected(order.orderId, reason);

  // Notify user
  try {
    await tg('sendMessage', {
      chat_id: order.chatId,
      text: `Your ${order.cardName} gift card sell was declined.\nReason: ${reason}\n\nThe card code may be invalid or already used.`,
    });
  } catch (err: any) {
    console.error(`[Prestmit Webhook] Failed to notify user ${order.userId}:`, err.message);
  }
}

// ─── Auto-Credit Pipeline ────────────────────────────────────

/**
 * Credit cUSD to user's wallet after Prestmit approves a sell order.
 *
 * Uses refundPayer() — same mechanic as auto-refund: agent wallet sends cUSD to user.
 * Dedup key: sell order ID (prevents double credit on webhook retry).
 */
export async function creditUser(
  orderId: string,
  userId: string,
  chatId: number,
  payoutAmountNgn: number,
  cardName: string,
): Promise<void> {
  try {
    // Convert NGN → cUSD
    const cusdAmount = await ngnToCusd(payoutAmountNgn);
    if (cusdAmount <= 0) {
      await markFailed(orderId, 'FX conversion returned zero');
      return;
    }

    console.log(`[Sell Credit] ${orderId}: ₦${payoutAmountNgn} → ${cusdAmount} cUSD for user ${userId}`);

    // We need the user's wallet address to credit them.
    // Import WalletManager lazily to avoid circular dependencies.
    const { getDb } = await import('../../wallet/mongo-store');
    const db = await getDb();
    const wallet = await db.collection('wallets').findOne({ telegramId: userId });

    if (!wallet?.address) {
      await markFailed(orderId, 'User wallet not found');
      await tg('sendMessage', {
        chat_id: chatId,
        text: `Your ${cardName} was approved (${cusdAmount} cUSD) but we couldn't find your wallet. Use /start to set up your wallet, then contact support.`,
      }).catch(() => {});
      return;
    }

    // Create service receipt for audit trail
    const receiptId = await createReceipt({
      paymentTxHash: `sell_credit_${orderId}`, // Synthetic — no payment tx
      payer: wallet.address,
      paymentAmount: cusdAmount.toString(),
      paymentToken: 'cUSD',
      paymentNetwork: CELO_CAIP2,
      serviceType: 'gift_card',
      source: 'telegram',
      serviceArgs: { type: 'sell_credit', orderId, cardName, payoutNgn: payoutAmountNgn },
    });

    // Credit user via agent wallet transfer
    const txHash = await refundPayer(
      wallet.address,
      cusdAmount,
      'sell_credit',
      `sell_credit_${orderId}`, // Dedup key
    );

    if (!txHash) {
      await markFailed(orderId, 'Agent wallet transfer failed');
      await updateReceipt(receiptId, { status: 'failed', error: 'Transfer failed' });
      await tg('sendMessage', {
        chat_id: chatId,
        text: `Your ${cardName} was approved (${cusdAmount} cUSD) but the credit failed. Our team has been notified — you'll receive your funds shortly.`,
      }).catch(() => {});
      return;
    }

    // Mark order as credited
    await markCredited(orderId, txHash, cusdAmount);
    await updateReceipt(receiptId, { status: 'success', reloadlyStatus: 'credited' });

    console.log(`[Sell Credit] ${orderId}: ${cusdAmount} cUSD credited to ${wallet.address} | tx: ${txHash}`);

    // Notify user
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Your ${cardName} gift card was approved!\n\n${cusdAmount.toFixed(2)} cUSD has been credited to your wallet.`,
    }).catch(() => {});
  } catch (err: any) {
    console.error(`[Sell Credit] Failed for ${orderId}:`, err.message);
    await markFailed(orderId, err.message);
  }
}
