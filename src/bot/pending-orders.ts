/**
 * Pending Order Store — MongoDB-backed orders awaiting user confirmation
 *
 * Orders go through: pending_confirmation → pending_payment → processing → completed/failed
 * Auto-expires via MongoDB TTL index. One active order per user.
 *
 * Survives server restarts — no more lost mid-confirmation orders.
 *
 * Race safety: status transitions use atomic findOneAndUpdate with a status filter,
 * so double-clicks can't cause duplicate payments.
 */

import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

export interface PendingOrder {
  orderId: string;
  telegramId: string;
  chatId: number;
  messageId?: number;

  // Order details (from AI agent)
  action: 'airtime' | 'data' | 'bill' | 'gift_card';
  description: string;
  productAmount: number;
  serviceFee: number;
  totalAmount: number;

  // Tool call details (to replay after confirmation)
  toolName: string;
  toolArgs: Record<string, any>;

  // State
  status: 'pending_confirmation' | 'pending_payment' | 'processing' | 'completed' | 'cancelled' | 'failed';
  createdAt: number;
  expiresAt: number;

  // Result
  txHash?: string;
  result?: any;
  error?: string;

  // TTL field for MongoDB auto-expiry
  _expiresAt?: Date;
}

const COLLECTION_NAME = 'pending_orders';
// Terminal orders kept 1 hour for rating & record-keeping
const TERMINAL_TTL_MS = 60 * 60 * 1000;
let _collection: Collection<PendingOrder> | null = null;
let _indexesCreated = false;

async function getCollection(): Promise<Collection<PendingOrder>> {
  if (_collection && _indexesCreated) return _collection;

  const db = await getDb();
  _collection = db.collection<PendingOrder>(COLLECTION_NAME);

  if (!_indexesCreated) {
    await _collection.createIndex({ orderId: 1 }, { unique: true });
    await _collection.createIndex({ telegramId: 1 });
    // TTL index — MongoDB auto-deletes expired orders
    await _collection.createIndex({ _expiresAt: 1 }, { expireAfterSeconds: 0 });
    _indexesCreated = true;
  }

  return _collection;
}

export class PendingOrderStore {
  async create(order: PendingOrder): Promise<void> {
    try {
      const col = await getCollection();
      // Cancel any existing non-terminal order for this user (including stuck processing)
      await col.deleteMany({
        telegramId: order.telegramId,
        status: { $in: ['pending_confirmation', 'pending_payment', 'processing'] },
      });
      // Insert with TTL date
      await col.insertOne({
        ...order,
        _expiresAt: new Date(order.expiresAt),
      });
    } catch (err: any) {
      console.error('[PendingOrders] Failed to create order:', err.message);
    }
  }

  async get(orderId: string): Promise<PendingOrder | null> {
    try {
      const col = await getCollection();
      const order = await col.findOne({ orderId });
      if (!order) return null;
      // For active orders, check expiry. Terminal orders have extended TTL.
      const isTerminal = order.status === 'completed' || order.status === 'failed' || order.status === 'cancelled';
      if (!isTerminal && Date.now() > order.expiresAt) {
        await this.remove(orderId);
        return null;
      }
      return order;
    } catch (err: any) {
      console.error('[PendingOrders] Failed to get order:', err.message);
      return null;
    }
  }

  async getByUser(telegramId: string): Promise<PendingOrder | null> {
    try {
      const col = await getCollection();
      const order = await col.findOne(
        { telegramId, status: { $in: ['pending_confirmation', 'pending_payment', 'processing'] } },
        { sort: { createdAt: -1 } },
      );
      if (!order) return null;
      if (Date.now() > order.expiresAt) {
        await this.remove(order.orderId);
        return null;
      }
      return order;
    } catch (err: any) {
      console.error('[PendingOrders] Failed to get user order:', err.message);
      return null;
    }
  }

  /**
   * Atomic status transition — uses findOneAndUpdate with a status filter.
   * Returns the updated order if the transition was valid, null if another
   * request already moved the status (prevents double-click races).
   */
  async atomicTransition(
    orderId: string,
    fromStatus: PendingOrder['status'] | PendingOrder['status'][],
    toStatus: PendingOrder['status'],
    extra?: Partial<PendingOrder>,
  ): Promise<PendingOrder | null> {
    try {
      const col = await getCollection();
      const statusFilter = Array.isArray(fromStatus) ? { $in: fromStatus } : fromStatus;
      const update: Record<string, any> = { status: toStatus };
      if (extra) Object.assign(update, extra);

      // Extend TTL for terminal states so rating/record-keeping works
      const isTerminal = toStatus === 'completed' || toStatus === 'failed' || toStatus === 'cancelled';
      if (isTerminal) {
        update._expiresAt = new Date(Date.now() + TERMINAL_TTL_MS);
      }

      const result = await col.findOneAndUpdate(
        { orderId, status: statusFilter },
        { $set: update },
        { returnDocument: 'after' },
      );

      return result ?? null;
    } catch (err: any) {
      console.error('[PendingOrders] Failed atomic transition:', err.message);
      return null;
    }
  }

  /**
   * Simple status update — for non-critical updates where race safety isn't needed.
   * For payment-critical transitions, use atomicTransition() instead.
   */
  async updateStatus(orderId: string, status: PendingOrder['status'], extra?: Partial<PendingOrder>): Promise<void> {
    try {
      const col = await getCollection();
      const update: Record<string, any> = { status };
      if (extra) Object.assign(update, extra);

      // Extend TTL for terminal states
      const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
      if (isTerminal) {
        update._expiresAt = new Date(Date.now() + TERMINAL_TTL_MS);
      }

      await col.updateOne({ orderId }, { $set: update });
    } catch (err: any) {
      console.error('[PendingOrders] Failed to update order:', err.message);
    }
  }

  async remove(orderId: string): Promise<void> {
    try {
      const col = await getCollection();
      await col.deleteOne({ orderId });
    } catch (err: any) {
      console.error('[PendingOrders] Failed to remove order:', err.message);
    }
  }

  async cleanup(): Promise<void> {
    // MongoDB TTL index handles expiry automatically — this is a no-op now
    // Kept for API compatibility
  }
}

/**
 * Generate a short unique order ID
 */
export function generateOrderId(): string {
  return `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
