/**
 * Sell Order Status Poller — Webhook fallback for Prestmit gift card sells.
 *
 * Polls Prestmit API every 5 minutes for pending sell orders that haven't
 * received webhook notifications. Defense-in-depth: webhooks are primary,
 * this catches anything that slips through.
 */

import { getStaleOrders, markRejected, SellOrder } from './sell-orders';
import { getSellOrderStatus } from '../apis/prestmit';
import { creditUser } from './telegram/webhook';

let _pollInterval: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // Only poll orders older than 2 min

type NotifyFn = (userId: string, chatId: number, message: string) => Promise<void>;

/**
 * Start the background sell order poller.
 * Runs every 5 minutes, checks pending orders for status updates.
 */
export function startSellOrderPoller(notify: NotifyFn): void {
  if (_pollInterval) return; // Already running

  console.log('[SellPoller] Started (every 5 min)');

  _pollInterval = setInterval(async () => {
    try {
      await pollPendingOrders(notify);
    } catch (err: any) {
      console.error('[SellPoller] Error:', err.message);
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the background poller (for graceful shutdown).
 */
export function stopSellOrderPoller(): void {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
    console.log('[SellPoller] Stopped');
  }
}

/**
 * Poll all stale pending orders and process any that have been resolved.
 */
async function pollPendingOrders(notify: NotifyFn): Promise<void> {
  const staleOrders = await getStaleOrders(STALE_THRESHOLD_MS);
  if (staleOrders.length === 0) return;

  console.log(`[SellPoller] Checking ${staleOrders.length} pending sell order(s)`);

  for (const order of staleOrders) {
    try {
      await checkAndProcessOrder(order, notify);
    } catch (err: any) {
      console.error(`[SellPoller] Failed to process ${order.orderId}:`, err.message);
    }
  }
}

/**
 * Check a single order's status with Prestmit and process if resolved.
 */
async function checkAndProcessOrder(order: SellOrder, notify: NotifyFn): Promise<void> {
  // Try to get status from Prestmit API
  const status = await getSellOrderStatus(order.prestmitReference);
  if (!status) return; // API unavailable or no result

  const normalizedStatus = status.status?.toUpperCase();

  if (normalizedStatus === 'COMPLETED') {
    // Card approved — trigger auto-credit
    const payoutAmount = status.totalAmount || order.payoutAmountLocal;
    console.log(`[SellPoller] Order ${order.orderId} approved (via poll) — crediting ${payoutAmount} NGN`);
    await creditUser(order.orderId, order.userId, order.chatId, payoutAmount, order.cardName);
  } else if (normalizedStatus === 'REJECTED') {
    // Card rejected
    const reason = status.rejectionReason || 'Card declined by Prestmit';
    await markRejected(order.orderId, reason);
    await notify(order.userId, order.chatId,
      `Your ${order.cardName} gift card sell was declined.\nReason: ${reason}`,
    );
    console.log(`[SellPoller] Order ${order.orderId} rejected: ${reason}`);
  }
  // If still PENDING — do nothing, check again next cycle
}
