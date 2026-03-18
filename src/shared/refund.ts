/**
 * Auto-refund: send cUSD from agent wallet back to a payer when service fails after payment.
 *
 * Used by all payment paths (x402 API, MCP, Telegram) to ensure users never lose funds
 * when Reloadly or other service providers fail after on-chain payment is verified.
 *
 * Security:
 * - Only called from server-side error handlers, never exposed as an endpoint.
 * - MongoDB-backed dedup guard prevents the same payment from being refunded twice.
 * - The agent wallet private key (CELO_PRIVATE_KEY) must be set.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, parseAbi, parseUnits } from 'viem';
import { celo, celoSepolia } from 'viem/chains';
import { PAYMENT_TOKEN_ADDRESS, PAYMENT_TOKEN_DECIMALS } from '../blockchain/x402';
import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

const isTestnet = process.env.NODE_ENV !== 'production';
const chain = isTestnet ? celoSepolia : celo;
const FEE_CURRENCY = isTestnet ? undefined : PAYMENT_TOKEN_ADDRESS;

const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

// ─── Refund Deduplication (V1 guard) ───────────────────────────

interface RefundRecord {
  _id: string;       // refundKey (payment tx hash or unique identifier)
  payerAddress: string;
  amountUsd: number;
  context: string;
  refundTxHash: string;
  createdAt: Date;
}

const REFUND_COLLECTION = 'refund_records';
let _refundCol: Collection<RefundRecord> | null = null;
let _refundIndexCreated = false;

async function getRefundCollection(): Promise<Collection<RefundRecord>> {
  if (_refundCol && _refundIndexCreated) return _refundCol;

  const db = await getDb();
  _refundCol = db.collection<RefundRecord>(REFUND_COLLECTION);

  if (!_refundIndexCreated) {
    // Unique _id is automatic in MongoDB — no extra index needed
    _refundIndexCreated = true;
  }

  return _refundCol;
}

/**
 * Atomically check if a refund was already issued for this key.
 * Returns true if the refund should proceed (no prior refund), false if already refunded.
 */
async function tryReserveRefund(refundKey: string): Promise<boolean> {
  const col = await getRefundCollection();
  try {
    // insertOne with _id acts as atomic reserve (unique constraint)
    await col.insertOne({
      _id: refundKey,
      payerAddress: '',
      amountUsd: 0,
      context: '',
      refundTxHash: '',
      createdAt: new Date(),
    });
    return true; // Reserved — proceed with refund
  } catch (err: any) {
    if (err.code === 11000) {
      // Duplicate key — refund already issued for this payment
      console.warn(`[Refund Dedup] Blocked duplicate refund for key: ${refundKey}`);
      return false;
    }
    console.error('[Refund Dedup] MongoDB error:', err.message);
    return false; // Fail-closed: don't refund on errors
  }
}

/**
 * Update the refund record with the actual tx details after successful on-chain refund.
 */
async function finalizeRefundRecord(
  refundKey: string,
  payerAddress: string,
  amountUsd: number,
  context: string,
  refundTxHash: string,
): Promise<void> {
  try {
    const col = await getRefundCollection();
    await col.updateOne(
      { _id: refundKey },
      { $set: { payerAddress, amountUsd, context, refundTxHash } },
    );
  } catch (err: any) {
    console.error('[Refund Dedup] Failed to finalize record:', err.message);
  }
}

/**
 * Mark a refund reservation as failed (keeps the record to block retries).
 * Failed refunds require manual admin review — never auto-release the reservation,
 * as that would allow retry loops that could drain the agent wallet.
 */
async function markRefundFailed(refundKey: string, error: string): Promise<void> {
  try {
    const col = await getRefundCollection();
    await col.updateOne(
      { _id: refundKey },
      { $set: { refundTxHash: `FAILED: ${error}`, context: 'failed_refund' } },
    );
  } catch (err: any) {
    console.error('[Refund Dedup] Failed to mark refund as failed:', err.message);
  }
}

// ─── Refund Execution ──────────────────────────────────────────

/**
 * Refund cUSD from agent wallet to a payer address.
 *
 * @param payerAddress - EVM address to refund to
 * @param amountUsd - Amount in USD to refund
 * @param context - Source context (e.g. 'x402_api', 'mcp', 'telegram')
 * @param refundKey - Unique key for deduplication (typically the payment tx hash).
 *                    If omitted, dedup check is skipped (legacy callers).
 * @returns The refund tx hash, or null if refund fails or was already issued.
 */
const MAX_REFUND_USD = 1000; // Safety cap — matches WalletManager.MAX_SINGLE_TRANSFER_USD

export async function refundPayer(
  payerAddress: string,
  amountUsd: number,
  context: string,
  refundKey?: string,
): Promise<string | null> {
  try {
    // Amount validation — defense in depth, mirrors WalletManager caps
    if (!amountUsd || !isFinite(amountUsd) || amountUsd <= 0) {
      console.error('[Refund] Invalid refund amount:', amountUsd);
      return null;
    }
    if (amountUsd > MAX_REFUND_USD) {
      console.error(`[Refund] Amount ${amountUsd} exceeds cap ${MAX_REFUND_USD} — requires manual review`);
      return null;
    }

    const agentPrivateKey = process.env.CELO_PRIVATE_KEY;
    if (!agentPrivateKey) {
      console.error('[Refund] CELO_PRIVATE_KEY not set — cannot refund');
      return null;
    }

    if (!payerAddress || !/^0x[0-9a-fA-F]{40}$/.test(payerAddress)) {
      console.error('[Refund] Invalid payer address format');
      return null;
    }

    // Dedup guard: prevent double refunds for the same payment
    if (refundKey) {
      const canProceed = await tryReserveRefund(refundKey);
      if (!canProceed) return null; // Already refunded
    }

    const agentAccount = privateKeyToAccount(agentPrivateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account: agentAccount,
      chain,
      transport: http(process.env.CELO_RPC_URL),
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(process.env.CELO_RPC_URL),
    });

    const amountWei = parseUnits(
      amountUsd.toFixed(PAYMENT_TOKEN_DECIMALS > 6 ? 8 : 6),
      PAYMENT_TOKEN_DECIMALS,
    );

    // Retry on-chain tx up to 3 times — transient RPC errors ("Block not found",
    // network timeouts) are common on Celo and usually resolve within seconds.
    let hash = '' as `0x${string}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        hash = await walletClient.writeContract({
          address: PAYMENT_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [payerAddress as `0x${string}`, amountWei],
          ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY } : {}),
        } as any);
        break; // Success — no need to retry
      } catch (txErr: any) {
        console.warn(`[Refund] Attempt ${attempt + 1}/3 failed: ${txErr.message}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        else throw txErr; // Final attempt failed — propagate
      }
    }

    await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

    // Finalize the dedup record with actual tx details
    if (refundKey) {
      await finalizeRefundRecord(refundKey, payerAddress, amountUsd, context, hash);
    }

    console.log(`[Refund] ${amountUsd} cUSD → ${payerAddress} (${context}) | tx: ${hash}`);
    return hash;
  } catch (err: any) {
    console.error(`[Refund FAILED] ${amountUsd} cUSD → ${payerAddress} (${context}):`, err.message);
    // Mark reservation as failed — do NOT release it (prevents retry-based wallet drain).
    // Failed refunds require manual admin review via the refund_records collection.
    if (refundKey) await markRefundFailed(refundKey, err.message);
    return null;
  }
}
