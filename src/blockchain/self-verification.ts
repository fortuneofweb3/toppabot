/**
 * Self Protocol Verification — ZK Proof of Humanity
 *
 * Complete integration with Self Protocol SDK for Sybil-resistant
 * identity verification. Users who verify via Self get higher daily
 * spending limits.
 *
 * Flow:
 *   1. User types /verify in Telegram or WhatsApp
 *   2. Bot creates a verification session and sends a Self universal link
 *   3. User clicks link → Self app opens → scans passport via NFC
 *   4. Self Protocol sends ZK proof to POST /api/verify
 *   5. Server verifies proof using SelfBackendVerifier
 *   6. On success, user gets upgraded spending limits ($20 → $200/day)
 *   7. Bot notifies user of successful verification
 *
 * Unverified users:  $20/day spending cap
 * Verified users:    $200/day spending cap
 *
 * Self Agent ID: #48 (Celo Sepolia)
 * Agent Address: 0x9480a88916074D9B2f62c6954a41Ea4B9B40b64c
 *
 * Docs: https://docs.self.xyz
 */

import crypto from 'node:crypto';
import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

// ── Self Protocol SDK ────────────────────────────────────────────────────
// The SDK uses `self` as a global variable internally (js-sha256),
// so we polyfill it for Node.js environments.
if (typeof globalThis.self === 'undefined') {
  (globalThis as any).self = globalThis;
}

import {
  SelfBackendVerifier,
  DefaultConfigStore,
  AllIds,
  getUniversalLink,
} from '@selfxyz/core';

// ── Config ───────────────────────────────────────────────────────────────

const SELF_SCOPE = process.env.SELF_SCOPE || 'toppa-verify';
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.toppa.cc';
const SELF_ENDPOINT = `${API_BASE_URL}/api/verify`;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── Spending Tiers ───────────────────────────────────────────────────────

export const UNVERIFIED_DAILY_LIMIT = 20;   // $20/day for unverified users
export const VERIFIED_DAILY_LIMIT = 200;    // $200/day for Self-verified users

// ── Backend Verifier (singleton) ─────────────────────────────────────────

let _verifier: InstanceType<typeof SelfBackendVerifier> | null = null;

function getVerifier(): InstanceType<typeof SelfBackendVerifier> {
  if (!_verifier) {
    _verifier = new SelfBackendVerifier(
      SELF_SCOPE,
      SELF_ENDPOINT,
      !IS_PRODUCTION, // true = staging (mock passports on Sepolia), false = mainnet (real passports)
      AllIds, // accept all document types (passport, ID card, etc.)
      new DefaultConfigStore({
        // No age restriction — we only care about proof of uniqueness
      }),
      'hex',
    );
  }
  return _verifier;
}

// ── Verification Status Store ────────────────────────────────────────────

export interface SelfVerification {
  userId: string;        // Telegram/WhatsApp user ID
  verified: boolean;
  verifiedAt?: Date;
  selfProof?: string;    // Self Protocol proof hash (no PII)
  nullifier?: string;    // Unique nullifier hash (Sybil resistance)
  expiresAt?: Date;      // Verification validity period
}

// Pending verification sessions — maps session token to bot user info
export interface PendingVerification {
  token: string;
  userId: string;        // Bot user ID (e.g. "tg:123456" or "wa:2348012345678")
  platform: 'telegram' | 'whatsapp';
  chatId: string;        // For sending confirmation message back
  createdAt: Date;
}

const COLLECTION_NAME = 'self_verifications';
const PENDING_COLLECTION = 'self_pending_verifications';
let _collection: Collection<SelfVerification> | null = null;
let _pendingCollection: Collection<PendingVerification> | null = null;
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

async function getPendingCollection(): Promise<Collection<PendingVerification>> {
  if (_pendingCollection) return _pendingCollection;

  const db = await getDb();
  _pendingCollection = db.collection<PendingVerification>(PENDING_COLLECTION);

  await _pendingCollection.createIndex({ token: 1 }, { unique: true });
  // Auto-expire pending sessions after 30 minutes
  await _pendingCollection.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 30 * 60 },
  ).catch(() => {});

  return _pendingCollection;
}

// ── Check Verification Status ────────────────────────────────────────────

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

// ── Create Verification Session ──────────────────────────────────────────

/**
 * Create a new verification session for a user.
 * Returns a Self Protocol universal deep link that opens the Self app.
 */
export async function createVerificationSession(
  userId: string,
  platform: 'telegram' | 'whatsapp',
  chatId: string,
): Promise<{ link: string; alreadyVerified: boolean }> {
  // Check if already verified
  const status = await getUserVerificationStatus(userId);
  if (status.verified) {
    return { link: '', alreadyVerified: true };
  }

  // Generate a unique session token
  const token = crypto.randomBytes(16).toString('hex');

  // Store the pending verification session
  const col = await getPendingCollection();
  await col.updateOne(
    { userId },
    {
      $set: {
        token,
        userId,
        platform,
        chatId,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );

  // Build the Self Protocol app config and universal link
  // We encode the session token as a zero-padded hex address for the userId field
  // The token gets sent back in the callback so we can identify the user
  const paddedToken = '0x' + token.padStart(40, '0');

  const selfApp = {
    version: 2,
    appName: 'Toppa',
    scope: SELF_SCOPE,
    endpoint: SELF_ENDPOINT,
    logoBase64: 'https://api.toppa.cc/agent-image.png',
    userId: paddedToken,
    endpointType: (IS_PRODUCTION ? 'https' : 'staging_https') as any,
    userIdType: 'hex' as const,
    disclosures: {
      // No age check or nationality disclosure — just proof of uniqueness
    },
  };

  const link = getUniversalLink(selfApp);
  console.log(`[Self] Verification session created for ${userId} (token: ${token.slice(0, 8)}...)`);

  return { link, alreadyVerified: false };
}

// ── Verify Proof (callback from Self Protocol) ───────────────────────────

/**
 * Verify a Self Protocol ZK proof received from the callback.
 * Called by the POST /api/verify endpoint.
 *
 * Returns the pending session info if verification succeeds,
 * so the caller can send a confirmation message to the user.
 */
export async function verifySelfProof(
  attestationId: number,
  proof: any,
  publicSignals: string[],
  userContextData: string,
): Promise<{
  success: boolean;
  userId?: string;
  platform?: 'telegram' | 'whatsapp';
  chatId?: string;
  error?: string;
}> {
  try {
    // Verify the ZK proof using Self SDK
    const verifier = getVerifier();
    const result = await verifier.verify(
      attestationId,
      proof,
      publicSignals,
      userContextData,
    );

    if (!result.isValidDetails.isValid) {
      console.warn('[Self] Proof verification failed:', result.isValidDetails);
      return { success: false, error: 'Proof verification failed' };
    }

    // Extract the session token from the userId (padded hex)
    // userContextData contains the userId we set in the SelfAppBuilder
    const token = userContextData.replace('0x', '').replace(/^0+/, '');

    // Look up the pending verification session
    const pendingCol = await getPendingCollection();
    const session = await pendingCol.findOne({ token });

    if (!session) {
      // Try with the raw userContextData as the token
      const session2 = await pendingCol.findOne({ token: userContextData });
      if (!session2) {
        console.warn('[Self] No pending session found for token:', token.slice(0, 8));
        return { success: false, error: 'Verification session expired or not found' };
      }
      // Use session2
      const nullifier = publicSignals[0] || crypto.randomBytes(32).toString('hex');
      const proofHash = crypto.createHash('sha256').update(JSON.stringify(proof)).digest('hex');

      const recorded = await recordVerification(session2.userId, {
        selfProof: proofHash,
        nullifier,
      });

      if (!recorded) {
        return { success: false, error: 'This identity has already been used by another account (Sybil protection)' };
      }

      // Clean up pending session
      await pendingCol.deleteOne({ token: userContextData });

      return {
        success: true,
        userId: session2.userId,
        platform: session2.platform,
        chatId: session2.chatId,
      };
    }

    // Extract a nullifier from public signals for Sybil resistance
    const nullifier = publicSignals[0] || crypto.randomBytes(32).toString('hex');
    const proofHash = crypto.createHash('sha256').update(JSON.stringify(proof)).digest('hex');

    // Record the verification
    const recorded = await recordVerification(session.userId, {
      selfProof: proofHash,
      nullifier,
    });

    if (!recorded) {
      return { success: false, error: 'This identity has already been used by another account (Sybil protection)' };
    }

    // Clean up pending session
    await pendingCol.deleteOne({ token });

    return {
      success: true,
      userId: session.userId,
      platform: session.platform,
      chatId: session.chatId,
    };
  } catch (err: any) {
    console.error('[Self] Proof verification error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Record Verification ──────────────────────────────────────────────────

/**
 * Record a successful Self Protocol verification.
 * Called after the Self SDK confirms the user's ZK proof.
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
      console.warn(`[Self] Sybil attempt: nullifier ${proof.nullifier.slice(0, 16)}... already used by ${existing.userId}`);
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

// ── Format Messages ──────────────────────────────────────────────────────

/**
 * Format the verification prompt sent when user types /verify.
 */
export function formatVerificationMessage(link: string): string {
  return [
    'Verify your identity with Self Protocol to unlock higher spending limits.',
    '',
    `Current limit: ${UNVERIFIED_DAILY_LIMIT} cUSD/day`,
    `Verified limit: ${VERIFIED_DAILY_LIMIT} cUSD/day`,
    '',
    'How it works:',
    '1. Tap the link below to open the Self app',
    '2. Scan your passport with NFC (takes ~30 seconds)',
    '3. Done! Your limits upgrade automatically',
    '',
    `Verify now: ${link}`,
    '',
    'Self uses zero-knowledge proofs — no personal data is shared with us.',
    "Don't have the Self app? Download it: https://self.xyz",
  ].join('\n');
}

/**
 * Format an "already verified" message.
 */
export function formatAlreadyVerifiedMessage(verifiedAt?: Date): string {
  const dateStr = verifiedAt ? ` on ${verifiedAt.toLocaleDateString()}` : '';
  return [
    `You're already verified${dateStr}!`,
    `Your daily spending limit is ${VERIFIED_DAILY_LIMIT} cUSD/day.`,
  ].join('\n');
}

/**
 * Format the success message sent after verification completes.
 */
export function formatVerificationSuccessMessage(): string {
  return [
    'Identity verified! Your daily spending limit has been upgraded.',
    '',
    `New limit: ${VERIFIED_DAILY_LIMIT} cUSD/day`,
    '',
    'Your verification is valid for 1 year. No personal data was stored — only a ZK proof of uniqueness.',
  ].join('\n');
}

/**
 * Format a verification prompt for when user hits their spending limit.
 */
export function formatSpendingLimitPrompt(): string {
  return `Daily limit of ${UNVERIFIED_DAILY_LIMIT} cUSD reached. Verify with Self Protocol to unlock ${VERIFIED_DAILY_LIMIT} cUSD/day! Use /verify to get started.`;
}
