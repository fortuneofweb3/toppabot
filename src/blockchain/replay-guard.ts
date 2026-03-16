/**
 * Payment Replay Guard — prevents tx hash reuse across all payment paths
 *
 * Uses MongoDB for persistence (survives restarts, works across instances).
 *
 * Used by:
 * - x402 REST API middleware (server.ts)
 * - MCP paid tools (mcp/tools.ts)
 *
 * Atomicity:
 * - Uses MongoDB unique _id constraint on the hash.
 * - insertOne either succeeds (hash is fresh) or throws duplicate key error (already used).
 * - No TOCTOU race condition — the database enforces uniqueness atomically.
 *
 * TTL:
 * - MongoDB TTL index on `createdAt` auto-deletes entries after 24 hours.
 * - No manual cleanup needed.
 */

import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

interface PaymentHashDoc {
  _id: string;        // normalized tx hash
  createdAt: Date;     // for TTL index
  source: string;      // which path used this hash (x402_api, mcp, telegram)
}

const COLLECTION_NAME = 'payment_hashes';

let _collection: Collection<PaymentHashDoc> | null = null;
let _indexesCreated = false;

async function getCollection(): Promise<Collection<PaymentHashDoc>> {
  if (_collection && _indexesCreated) return _collection;

  const db = await getDb();
  _collection = db.collection<PaymentHashDoc>(COLLECTION_NAME);

  if (!_indexesCreated) {
    // TTL index: MongoDB auto-deletes documents 24 hours after createdAt
    await _collection.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 24 * 60 * 60 },
    );
    _indexesCreated = true;
  }

  return _collection;
}

/**
 * Atomically reserve a tx hash. Returns true if fresh, false if already used.
 *
 * Uses MongoDB's unique _id constraint for atomicity —
 * two concurrent insertOne calls with the same _id will not both succeed.
 */
export async function reservePaymentHash(txHash: string, source: string = 'unknown'): Promise<boolean> {
  const normalized = txHash.toLowerCase().trim();

  if (!normalized || normalized.length < 10) {
    return false; // Invalid hash
  }

  try {
    const col = await getCollection();
    await col.insertOne({
      _id: normalized,
      createdAt: new Date(),
      source,
    });
    return true; // Fresh hash — reserved successfully
  } catch (err: any) {
    if (err.code === 11000) {
      // Duplicate key error — hash already exists (used)
      return false;
    }
    // Unexpected error — log and reject (fail-closed)
    console.error('[ReplayGuard] MongoDB error during reserve:', err.message);
    return false;
  }
}

/**
 * Release a reserved hash (call if verification fails after reservation).
 * Prevents a failed verification from permanently blocking a hash.
 */
export async function releasePaymentHash(txHash: string): Promise<void> {
  const normalized = txHash.toLowerCase().trim();
  try {
    const col = await getCollection();
    await col.deleteOne({ _id: normalized });
  } catch (err: any) {
    // Non-critical — hash will expire via TTL in 24h at worst
    console.error('[ReplayGuard] MongoDB error during release:', err.message);
  }
}

/**
 * Check if a hash is already used (without reserving).
 */
export async function isPaymentHashUsed(txHash: string): Promise<boolean> {
  const normalized = txHash.toLowerCase().trim();
  try {
    const col = await getCollection();
    const doc = await col.findOne({ _id: normalized });
    return doc !== null;
  } catch (err: any) {
    console.error('[ReplayGuard] MongoDB error during check:', err.message);
    return false;
  }
}

/**
 * Get stats for monitoring.
 */
export async function getReplayGuardStats() {
  try {
    const col = await getCollection();
    const totalTracked = await col.countDocuments();
    return {
      totalTracked,
      ttlHours: 24,
      storage: 'mongodb',
    };
  } catch {
    return {
      totalTracked: -1,
      ttlHours: 24,
      storage: 'mongodb (error)',
    };
  }
}
