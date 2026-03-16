/**
 * Service Receipt Tracking — MongoDB-backed transaction receipts
 *
 * Records every paid service execution across all channels (x402 API, MCP, Telegram).
 * Provides a complete audit trail of:
 * - What was paid (payment tx hash, amount, payer)
 * - What was requested (service type, args)
 * - What happened (success/failure, Reloadly tx ID, error)
 * - Settlement status (for x402 spec compliance)
 *
 * This is critical for:
 * 1. Dispute resolution (prove service was delivered)
 * 2. Refund tracking (know what failed after payment)
 * 3. x402 PAYMENT-RESPONSE header (return settlement receipt)
 * 4. Analytics (service usage, failure rates)
 */

import { Collection, ObjectId } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

export interface ServiceReceipt {
  _id?: ObjectId;

  // Payment info
  paymentTxHash: string;             // On-chain tx hash of the payment
  payer: string;                     // Wallet address that paid
  paymentAmount: string;             // Amount paid (human-readable)
  paymentToken: string;              // Token symbol (cUSD/USDC)
  paymentNetwork: string;            // Chain name

  // Service info
  serviceType: 'airtime' | 'data' | 'bill_payment' | 'gift_card';
  source: 'x402_api' | 'mcp' | 'telegram';
  serviceArgs: Record<string, any>;  // Sanitized args (no secrets)

  // Execution result
  status: 'success' | 'failed' | 'pending';
  reloadlyTransactionId?: number;    // Reloadly's transaction ID
  reloadlyStatus?: string;           // Reloadly's status string
  serviceResult?: Record<string, any>; // Sanitized result
  error?: string;                    // Error message if failed

  // Timing
  createdAt: Date;
  completedAt?: Date;

  // x402 settlement receipt (for PAYMENT-RESPONSE header)
  settlementReceipt?: {
    success: boolean;
    transaction: string;
    network: string;
    payer: string;
  };
}

const COLLECTION_NAME = 'service_receipts';
let _collection: Collection<ServiceReceipt> | null = null;
let _indexesCreated = false;

async function getCollection(): Promise<Collection<ServiceReceipt>> {
  if (_collection && _indexesCreated) return _collection;

  const db = await getDb();
  _collection = db.collection<ServiceReceipt>(COLLECTION_NAME);

  if (!_indexesCreated) {
    // Index on payment tx hash for quick lookup
    await _collection.createIndex({ paymentTxHash: 1 });
    // Index on source + createdAt for channel-specific queries
    await _collection.createIndex({ source: 1, createdAt: -1 });
    // Index on payer for user history
    await _collection.createIndex({ payer: 1, createdAt: -1 });
    // TTL: keep receipts for 90 days
    await _collection.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 90 * 24 * 60 * 60 },
    );
    _indexesCreated = true;
  }

  return _collection;
}

/**
 * Create a new service receipt before executing the service.
 * Returns the receipt ID for updating after execution.
 */
export async function createReceipt(receipt: Omit<ServiceReceipt, '_id' | 'createdAt' | 'status'> & { status?: string }): Promise<string> {
  try {
    const col = await getCollection();
    const doc: ServiceReceipt = {
      ...receipt,
      status: (receipt.status as any) || 'pending',
      createdAt: new Date(),
    };
    const result = await col.insertOne(doc);
    return result.insertedId.toString();
  } catch (err: any) {
    console.error('[ServiceReceipts] Failed to create receipt:', err.message);
    return ''; // Non-critical — don't block service execution
  }
}

/**
 * Update a receipt after service execution completes (success or failure).
 */
export async function updateReceipt(receiptId: string, update: {
  status: 'success' | 'failed';
  reloadlyTransactionId?: number;
  reloadlyStatus?: string;
  serviceResult?: Record<string, any>;
  error?: string;
  settlementReceipt?: ServiceReceipt['settlementReceipt'];
}): Promise<void> {
  if (!receiptId) return;
  try {
    const col = await getCollection();
    await col.updateOne(
      { _id: new ObjectId(receiptId) },
      {
        $set: {
          ...update,
          completedAt: new Date(),
        },
      },
    );
  } catch (err: any) {
    console.error('[ServiceReceipts] Failed to update receipt:', err.message);
  }
}

/**
 * Get a receipt by payment tx hash.
 * Used to check if a service was already delivered for a given payment.
 */
export async function getReceiptByTxHash(txHash: string): Promise<ServiceReceipt | null> {
  try {
    const col = await getCollection();
    return await col.findOne({ paymentTxHash: txHash.toLowerCase().trim() });
  } catch (err: any) {
    console.error('[ServiceReceipts] Failed to get receipt:', err.message);
    return null;
  }
}

/**
 * Get receipts for a payer (for transaction history).
 */
export async function getReceiptsByPayer(payer: string, limit: number = 20): Promise<ServiceReceipt[]> {
  try {
    const col = await getCollection();
    return await col
      .find({ payer: payer.toLowerCase() })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 100))
      .toArray();
  } catch (err: any) {
    console.error('[ServiceReceipts] Failed to get receipts:', err.message);
    return [];
  }
}

/**
 * Get failed receipts where payment was taken but service failed.
 * These are candidates for manual review/refund.
 */
export async function getFailedReceipts(limit: number = 50): Promise<ServiceReceipt[]> {
  try {
    const col = await getCollection();
    return await col
      .find({ status: 'failed' })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  } catch (err: any) {
    console.error('[ServiceReceipts] Failed to get failed receipts:', err.message);
    return [];
  }
}

/**
 * Get receipt stats for monitoring.
 */
export async function getReceiptStats(): Promise<{
  total: number;
  successful: number;
  failed: number;
  pending: number;
  bySource: Record<string, number>;
}> {
  try {
    const col = await getCollection();
    const [total, successful, failed, pending] = await Promise.all([
      col.countDocuments(),
      col.countDocuments({ status: 'success' }),
      col.countDocuments({ status: 'failed' }),
      col.countDocuments({ status: 'pending' }),
    ]);

    const sourceCounts = await col.aggregate([
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]).toArray();

    const bySource: Record<string, number> = {};
    for (const s of sourceCounts) {
      bySource[s._id as string] = s.count;
    }

    return { total, successful, failed, pending, bySource };
  } catch {
    return { total: -1, successful: -1, failed: -1, pending: -1, bySource: {} };
  }
}
