/**
 * Self Protocol Verification — ZK Proof of Humanity
 *
 * Integrates Self Protocol for Sybil-resistant identity verification.
 * Users who verify via Self get higher daily spending limits.
 *
 * Unverified users:  $20/day spending cap
 * Verified users:    $200/day spending cap
 *
 * Self Protocol uses zero-knowledge proofs from passport NFC scanning —
 * no personal data is disclosed, just proof of uniqueness.
 *
 * Self Agent ID: #48 (Celo Sepolia)
 * Agent Address: 0x9480a88916074D9B2f62c6954a41Ea4B9B40b64c
 *
 * Docs: https://docs.self.xyz
 */

import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

// ── Spending Tiers ────────────────────────────────────────────────────────

export const UNVERIFIED_DAILY_LIMIT = 20;   // $20/day for unverified users
export const VERIFIED_DAILY_LIMIT = 200;    // $200/day for Self-verified users

// ── Verification Status Store ─────────────────────────────────────────────

export interface SelfVerification {
  userId: string;        // Telegram/WhatsApp user ID
  verified: boolean;
  verifiedAt?: Date;
  selfProof?: string;    // Self Protocol proof identifier (no PII)
  nullifier?: string;    // Unique nullifier hash (Sybil resistance)
  expiresAt?: Date;      // Verification validity period
}

const COLLECTION_NAME = 'self_verifications';
let _collection: Collection<SelfVerification> | null = null;
let _indexesCreated = false;

async function getCollection(): Promise<Collection<SelfVerification>> {
  if (_collection && _indexesCreated) return _collection;

  const db = await getDb();
  _collection = db.collection<SelfVerification>(COLLECTION_NAME);

  if (!_indexesCreated) {
    await _collection.createIndex({ userId: 1 }, { unique: true });
    await _collection.createIndex({ nullifier: 1 }, { sparse: true });
    _indexesCreated = true;
  }

  return _collection;
}

// ── Check Verification Status ─────────────────────────────────────────────

/**
 * Check if a user is Self-verified.
 * Returns the appropriate daily spending limit.
 */
export async function getUserVerificationStatus(userId: string): Promise<{
  verified: boolean;
  dailyLimit: number;
  verifiedAt?: Date;
}> {
  try {
    const col = await getCollection();
    const record = await col.findOne({ userId });

    if (record?.verified) {
      // Check if verification hasn't expired (valid for 1 year)
      if (record.expiresAt && new Date() > record.expiresAt) {
        return { verified: false, dailyLimit: UNVERIFIED_DAILY_LIMIT };
      }
      return {
        verified: true,
        dailyLimit: VERIFIED_DAILY_LIMIT,
        verifiedAt: record.verifiedAt,
      };
    }

    return { verified: false, dailyLimit: UNVERIFIED_DAILY_LIMIT };
  } catch (err: any) {
    console.error('[Self] Failed to check verification:', err.message);
    return { verified: false, dailyLimit: UNVERIFIED_DAILY_LIMIT };
  }
}

/**
 * Get the spending limit for a user based on their verification status.
 */
export async function getDailySpendingLimit(userId: string): Promise<number> {
  const { dailyLimit } = await getUserVerificationStatus(userId);
  return dailyLimit;
}

// ── Record Verification ───────────────────────────────────────────────────

/**
 * Record a successful Self Protocol verification.
 * Called after the Self SDK callback confirms the user's ZK proof.
 */
export async function recordVerification(
  userId: string,
  proof: { selfProof: string; nullifier: string },
): Promise<boolean> {
  try {
    const col = await getCollection();

    // Check for Sybil: same nullifier used by another user
    const existing = await col.findOne({
      nullifier: proof.nullifier,
      userId: { $ne: userId },
    });

    if (existing) {
      console.warn(`[Self] Sybil attempt: nullifier ${proof.nullifier} already used by ${existing.userId}`);
      return false;
    }

    await col.updateOne(
      { userId },
      {
        $set: {
          verified: true,
          verifiedAt: new Date(),
          selfProof: proof.selfProof,
          nullifier: proof.nullifier,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        },
      },
      { upsert: true },
    );

    console.log(`[Self] User ${userId} verified successfully`);
    return true;
  } catch (err: any) {
    console.error('[Self] Failed to record verification:', err.message);
    return false;
  }
}

// ── Generate Verification Link ────────────────────────────────────────────

/**
 * Generate a Self Protocol verification deep link for the user.
 * The user scans a QR code in the Self app to prove humanity.
 */
export function generateVerificationLink(userId: string): string {
  const baseUrl = process.env.API_BASE_URL || 'https://api.toppa.cc';
  return `${baseUrl}/api/verify?userId=${encodeURIComponent(userId)}`;
}

/**
 * Format a verification prompt message for the user.
 */
export function formatVerificationPrompt(userId: string, currentLimit: number): string {
  const link = generateVerificationLink(userId);
  return [
    `Your daily spending limit is ${currentLimit} cUSD.`,
    `Verify your identity with Self Protocol to unlock ${VERIFIED_DAILY_LIMIT} cUSD/day.`,
    `Verify: ${link}`,
    `Self uses zero-knowledge proofs — no personal data is shared.`,
  ].join('\n');
}
