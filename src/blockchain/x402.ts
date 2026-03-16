import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { celo, celoSepolia } from 'viem/chains';

/**
 * x402 Payment Protocol — HTTP 402 Payment Required
 *
 * Implements the Coinbase x402 standard for agent-to-agent micropayments.
 * Spec: https://github.com/coinbase/x402
 *
 * Flow:
 * 1. Client calls paid endpoint without payment header
 * 2. Server returns 402 with PAYMENT-REQUIRED header
 * 3. Client pays cUSD to agent wallet on Celo
 * 4. Client retries with PAYMENT-SIGNATURE header (containing tx hash)
 * 5. Server verifies on-chain payment and returns 200
 *
 * For the hackathon, we use a simplified verification:
 * verify the tx hash on-chain (exists, correct recipient, correct token, sufficient amount).
 */

const isTestnet = process.env.NODE_ENV !== 'production';
const chain = isTestnet ? celoSepolia : celo;

// Payment token addresses on Celo
// Sepolia uses USDC (cUSD doesn't exist on Celo Sepolia)
// Mainnet uses cUSD
export const PAYMENT_TOKEN_ADDRESS = isTestnet
  ? '0x01C5C0122039549AD1493B8220cABEdD739BC44E' as `0x${string}` // USDC on Celo Sepolia
  : '0x765DE816845861e75A25fCA122bb6898B8B1282a' as `0x${string}`; // cUSD on Celo Mainnet
export const PAYMENT_TOKEN_SYMBOL = isTestnet ? 'USDC' : 'cUSD';
export const PAYMENT_TOKEN_DECIMALS = isTestnet ? 6 : 18;

const _rawAgentWallet = process.env.AGENT_WALLET_ADDRESS || '';
if (_rawAgentWallet && !/^0x[0-9a-fA-F]{40}$/.test(_rawAgentWallet)) {
  throw new Error(`AGENT_WALLET_ADDRESS is malformed: ${_rawAgentWallet.slice(0, 10)}... Must be 0x + 40 hex chars.`);
}
if (!_rawAgentWallet) {
  console.warn('[WARN] AGENT_WALLET_ADDRESS not set. Payment verification will fail.');
}
const AGENT_WALLET = _rawAgentWallet as `0x${string}`;
const SERVICE_FEE_PERCENT = 0.015; // 1.5% flat fee on product cost

/**
 * Calculate total x402 payment for a request
 *
 * Total = product_amount + (product_amount * 1.5%)
 * Simple flat percentage, no minimums.
 *
 * Examples:
 *   $5 airtime   → $5 + $0.08  = $5.08 total
 *   $25 gift card → $25 + $0.38 = $25.38 total
 *   $100 bill    → $100 + $1.50 = $101.50 total
 *   $500 bill    → $500 + $7.50 = $507.50 total
 */
export function calculateTotalPayment(productAmount?: number): {
  total: number;
  productAmount: number;
  serviceFee: number;
} {
  if (!productAmount || productAmount <= 0) {
    return { total: 0, productAmount: 0, serviceFee: 0 };
  }
  const serviceFee = Math.round(productAmount * SERVICE_FEE_PERCENT * 100) / 100;
  const total = Math.round((productAmount + serviceFee) * 100) / 100;
  return { total, productAmount, serviceFee };
}

// ERC-20 Transfer event signature
const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

// Lazy-initialized client
let _publicClient: ReturnType<typeof createPublicClient> | null = null;

function getPublicClient() {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain,
      transport: http(process.env.CELO_RPC_URL),
    });
  }
  return _publicClient;
}

/**
 * Create x402 payment request (returned in 402 response)
 * Follows the x402 spec payment requirements format
 */
export async function createX402PaymentRequest(params: {
  service: string;
  description: string;
  productAmount?: number;
}) {
  const { total, productAmount, serviceFee } = calculateTotalPayment(params.productAmount);

  // x402 payment requirements per spec
  const paymentRequirements = {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: chain.name.toLowerCase(),
        maxAmountRequired: String(Math.round(total * (10 ** PAYMENT_TOKEN_DECIMALS))),
        resource: params.service,
        description: params.description,
        mimeType: 'application/json',
        payTo: AGENT_WALLET,
        maxTimeoutSeconds: 300,
        asset: PAYMENT_TOKEN_ADDRESS,
        extra: {
          name: PAYMENT_TOKEN_SYMBOL,
          version: '1',
          decimals: PAYMENT_TOKEN_DECIMALS,
          humanReadableAmount: total.toString(),
          breakdown: {
            productAmount,
            serviceFee,
            total,
          },
        },
      },
    ],
    error: `Payment required: ${total} ${PAYMENT_TOKEN_SYMBOL} (product: ${productAmount}, fee: ${serviceFee}). Send to payTo address and include tx hash in X-PAYMENT header.`,
  };

  return {
    statusCode: 402,
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-Required': Buffer.from(JSON.stringify(paymentRequirements)).toString('base64'),
    },
    body: paymentRequirements,
  };
}

/**
 * Verify x402 payment on-chain
 *
 * Checks that:
 * 1. Transaction exists on Celo
 * 2. Transaction is confirmed (not pending)
 * 3. Contains a cUSD Transfer event to our wallet
 * 4. Amount is >= required fee
 */
export async function verifyX402Payment(paymentData: string, requiredAmount?: number): Promise<{
  verified: boolean;
  txHash?: string;
  payer?: string;
  amount?: string;
  error?: string;
}> {
  try {
    // paymentData could be a raw tx hash or base64-encoded payment payload
    let txHash: `0x${string}`;

    if (paymentData.startsWith('0x')) {
      txHash = paymentData as `0x${string}`;
    } else {
      // Try to decode base64 payload (x402 v2 format)
      try {
        const decoded = JSON.parse(Buffer.from(paymentData, 'base64').toString());
        txHash = (decoded.payload?.txHash || decoded.txHash || paymentData) as `0x${string}`;
      } catch {
        txHash = paymentData as `0x${string}`;
      }
    }

    const client = getPublicClient();

    // Get transaction receipt
    const receipt = await client.getTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      return { verified: false, error: 'Transaction failed or reverted' };
    }

    // Check transaction age — reject payments older than 1 hour
    const MAX_TX_AGE_BLOCKS = 720; // ~1 hour at 5s/block on Celo
    try {
      const currentBlock = await client.getBlockNumber();
      const txAge = currentBlock - receipt.blockNumber;
      if (txAge > MAX_TX_AGE_BLOCKS) {
        return { verified: false, error: `Transaction too old (${txAge} blocks ago, max ${MAX_TX_AGE_BLOCKS}). Submit a fresh payment.` };
      }
    } catch {
      // If we can't check block number, continue with other checks
    }

    // Look for cUSD Transfer event to our wallet
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
    const agentWalletPadded = AGENT_WALLET.toLowerCase().replace('0x', '0x000000000000000000000000');

    let payer: string | undefined;
    let amount: bigint = BigInt(0);

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === PAYMENT_TOKEN_ADDRESS.toLowerCase() &&
        log.topics[0] === transferTopic &&
        log.topics.length >= 3 &&
        log.topics[2]?.toLowerCase() === agentWalletPadded
      ) {
        payer = '0x' + (log.topics[1]?.slice(26) || '');
        try {
          amount = BigInt(log.data);
        } catch {
          continue; // Malformed log data — skip this log
        }
        break;
      }
    }

    if (!payer || amount === BigInt(0)) {
      return { verified: false, error: `No ${PAYMENT_TOKEN_SYMBOL} transfer to agent wallet found in transaction` };
    }

    // Check amount is sufficient (with 0.2% tolerance for minor rounding)
    const minRequired = requiredAmount ?? 0;
    const requiredWei = BigInt(Math.round(minRequired * (10 ** PAYMENT_TOKEN_DECIMALS) * 0.998));
    if (amount < requiredWei) {
      return {
        verified: false,
        error: `Insufficient payment: got ${formatUnits(amount, PAYMENT_TOKEN_DECIMALS)} ${PAYMENT_TOKEN_SYMBOL}, need ${minRequired} ${PAYMENT_TOKEN_SYMBOL}`,
      };
    }

    return {
      verified: true,
      txHash,
      payer,
      amount: formatUnits(amount, PAYMENT_TOKEN_DECIMALS),
    };
  } catch (error: any) {
    return {
      verified: false,
      error: `Verification failed: ${error.message}`,
    };
  }
}

/**
 * Get x402 protocol info for the agent
 */
export function getX402Info() {
  return {
    protocol: 'x402',
    version: 1,
    fee: `${SERVICE_FEE_PERCENT * 100}% of product amount`,
    feePercent: SERVICE_FEE_PERCENT,
    currency: PAYMENT_TOKEN_SYMBOL,
    chain: chain.name,
    asset: PAYMENT_TOKEN_ADDRESS,
    payTo: AGENT_WALLET,
    spec: 'https://github.com/coinbase/x402',
  };
}
