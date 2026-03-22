/**
 * Sell Order Store — MongoDB-backed tracking for Prestmit gift card sells.
 *
 * Tracks the lifecycle of a sell order from submission through verification
 * to auto-credit. Used by the webhook handler and background poller.
 *
 * Status flow: pending → approved/rejected → credited/failed
 */

import crypto from 'crypto';
import { Collection, ObjectId } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

// ─── Types ───────────────────────────────────────────────────

export interface SellOrder {
  _id?: ObjectId;
  orderId: string;               // Our internal ID (sell_<timestamp>_<hex>)
  prestmitReference: string;     // Prestmit's reference (e.g., "SGC586326085289")
  userId: string;                // Telegram user ID
  chatId: number;                // For notifications
  cardName: string;
  faceValue: number;             // Card face value submitted
  payoutMethod: string;          // "NAIRA" | "USDT" | "BITCOINS"
  payoutAmountLocal: number;     // Prestmit's totalAmount in payout currency
  estimatedCusd: number;         // Our estimated cUSD equivalent
  status: 'pending' | 'approved' | 'rejected' | 'credited' | 'failed';
  rejectionReason?: string;
  creditTxHash?: string;         // On-chain tx when we credit the user
  creditAmountCusd?: number;     // Actual cUSD credited
  createdAt: Date;
  updatedAt: Date;
  _expiresAt: Date;              // TTL: 30 days
}

// ─── Store ───────────────────────────────────────────────────

const COLLECTION = 'sell_orders';
const TTL_DAYS = 30;

let _col: Collection<SellOrder> | null = null;
let _indexesCreated = false;

async function getCollection(): Promise<Collection<SellOrder>> {
  if (_col && _indexesCreated) return _col;

  const db = await getDb();
  _col = db.collection<SellOrder>(COLLECTION);

  if (!_indexesCreated) {
    await Promise.all([
      _col.createIndex({ orderId: 1 }, { unique: true }),
      _col.createIndex({ prestmitReference: 1 }, { unique: true, sparse: true }),
      _col.createIndex({ userId: 1, status: 1 }),
      _col.createIndex({ status: 1, createdAt: 1 }),
      _col.createIndex({ _expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
    _indexesCreated = true;
  }

  return _col;
}

/**
 * Generate a unique sell order ID.
 * Format: sell_<13-digit-timestamp>_<8-hex>
 */
export function generateSellOrderId(): string {
  const ts = Date.now().toString();
  const rand = crypto.randomBytes(4).toString('hex');
  return `sell_${ts}_${rand}`;
}

/**
 * Create a new sell order.
 */
export async function createSellOrder(order: Omit<SellOrder, '_id' | 'createdAt' | 'updatedAt' | '_expiresAt'>): Promise<string> {
  const col = await getCollection();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_DAYS * 24 * 60 * 60 * 1000);

  await col.insertOne({
    ...order,
    createdAt: now,
    updatedAt: now,
    _expiresAt: expiresAt,
  } as SellOrder);

  return order.orderId;
}

/**
 * Look up a sell order by our internal order ID.
 */
export async function getSellOrderByOrderId(orderId: string): Promise<SellOrder | null> {
  const col = await getCollection();
  return col.findOne({ orderId });
}

/**
 * Look up a sell order by Prestmit's trade reference.
 * Used by webhook handler and poller.
 */
export async function getSellOrderByReference(reference: string): Promise<SellOrder | null> {
  const col = await getCollection();
  return col.findOne({ prestmitReference: reference });
}

/**
 * Look up a sell order by our uniqueIdentifier (same as orderId).
 * Prestmit sends this back as `partnersApiIdentifier` in webhooks.
 */
export async function getSellOrderByIdentifier(identifier: string): Promise<SellOrder | null> {
  const col = await getCollection();
  return col.findOne({ orderId: identifier });
}

/**
 * Get all pending sell orders for a user.
 */
export async function getUserPendingSellOrders(userId: string): Promise<SellOrder[]> {
  const col = await getCollection();
  return col.find({ userId, status: 'pending' }).sort({ createdAt: -1 }).toArray();
}

/**
 * Get all sell orders for a user (any status).
 */
export async function getUserSellOrders(userId: string, limit = 10): Promise<SellOrder[]> {
  const col = await getCollection();
  return col.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray();
}

/**
 * Get all pending sell orders older than a threshold (for polling).
 */
export async function getStaleOrders(olderThanMs = 2 * 60 * 1000): Promise<SellOrder[]> {
  const col = await getCollection();
  const threshold = new Date(Date.now() - olderThanMs);
  return col.find({
    status: 'pending',
    createdAt: { $lt: threshold },
  }).toArray();
}

/**
 * Mark a sell order as approved (card verified by Prestmit).
 * Atomic transition: only updates if currently 'pending'.
 */
export async function markApproved(
  orderId: string,
  payoutAmount: number,
): Promise<SellOrder | null> {
  const col = await getCollection();
  const result = await col.findOneAndUpdate(
    { orderId, status: 'pending' },
    {
      $set: {
        status: 'approved' as const,
        payoutAmountLocal: payoutAmount,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  return result || null;
}

/**
 * Mark a sell order as rejected.
 * Atomic transition: only updates if currently 'pending'.
 */
export async function markRejected(
  orderId: string,
  reason: string,
): Promise<SellOrder | null> {
  const col = await getCollection();
  const result = await col.findOneAndUpdate(
    { orderId, status: 'pending' },
    {
      $set: {
        status: 'rejected' as const,
        rejectionReason: reason,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  return result || null;
}

/**
 * Mark a sell order as credited (cUSD sent to user wallet).
 * Atomic transition: only updates if currently 'approved'.
 */
export async function markCredited(
  orderId: string,
  txHash: string,
  amountCusd: number,
): Promise<SellOrder | null> {
  const col = await getCollection();
  const result = await col.findOneAndUpdate(
    { orderId, status: 'approved' },
    {
      $set: {
        status: 'credited' as const,
        creditTxHash: txHash,
        creditAmountCusd: amountCusd,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  return result || null;
}

/**
 * Mark a sell order as failed (auto-credit failed).
 */
export async function markFailed(
  orderId: string,
  reason: string,
): Promise<void> {
  const col = await getCollection();
  await col.updateOne(
    { orderId },
    {
      $set: {
        status: 'failed' as const,
        rejectionReason: reason,
        updatedAt: new Date(),
      },
    },
  );
}
