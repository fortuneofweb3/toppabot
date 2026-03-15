import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { celo, celoAlfajores } from 'viem/chains';

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
const chain = isTestnet ? celoAlfajores : celo;

// cUSD token addresses on Celo
const CUSD_ADDRESS = isTestnet
  ? '0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1' as `0x${string}` // Alfajores
  : '0x765DE816845861e75A25fCA122bb6898B8B1282a' as `0x${string}`; // Mainnet

const AGENT_WALLET = (process.env.AGENT_WALLET_ADDRESS || '') as `0x${string}`;
const X402_FEE = parseFloat(process.env.X402_FEE_AMOUNT || '0.5');

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
  amount?: number;
}) {
  const paymentAmount = params.amount || X402_FEE;

  // x402 payment requirements per spec
  const paymentRequirements = {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: chain.name.toLowerCase(),
        maxAmountRequired: String(Math.round(paymentAmount * 1e18)), // wei
        resource: params.service,
        description: params.description,
        mimeType: 'application/json',
        payTo: AGENT_WALLET,
        maxTimeoutSeconds: 300,
        asset: CUSD_ADDRESS,
        extra: {
          name: 'cUSD',
          version: '1',
          decimals: 18,
          humanReadableAmount: paymentAmount.toString(),
        },
      },
    ],
    error: 'Payment required. Send cUSD to the payTo address and include the tx hash in the X-PAYMENT header.',
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
export async function verifyX402Payment(paymentData: string): Promise<{
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

    // Look for cUSD Transfer event to our wallet
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
    const agentWalletPadded = AGENT_WALLET.toLowerCase().replace('0x', '0x000000000000000000000000');

    let payer: string | undefined;
    let amount: bigint = BigInt(0);

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === CUSD_ADDRESS.toLowerCase() &&
        log.topics[0] === transferTopic &&
        log.topics[2]?.toLowerCase() === agentWalletPadded
      ) {
        payer = '0x' + (log.topics[1]?.slice(26) || '');
        amount = BigInt(log.data);
        break;
      }
    }

    if (!payer || amount === BigInt(0)) {
      return { verified: false, error: 'No cUSD transfer to agent wallet found in transaction' };
    }

    // Check amount is sufficient (with 1% tolerance for rounding)
    const requiredWei = BigInt(Math.round(X402_FEE * 1e18 * 0.99));
    if (amount < requiredWei) {
      return {
        verified: false,
        error: `Insufficient payment: got ${formatUnits(amount, 18)} cUSD, need ${X402_FEE} cUSD`,
      };
    }

    return {
      verified: true,
      txHash,
      payer,
      amount: formatUnits(amount, 18),
    };
  } catch (error: any) {
    return {
      verified: false,
      error: `Verification failed: ${error.message}`,
    };
  }
}

/**
 * Charge x402 fee (used in Telegram bot for tracking)
 * In the API, payment is verified via middleware instead
 */
export async function chargeX402Fee(params: {
  userId: string;
  transactionType: string;
  amount: number;
}) {
  if (process.env.X402_ENABLED !== 'true') {
    return { charged: false, fee: 0 };
  }

  // For Telegram: log the interaction (actual payment handled differently)
  return {
    charged: false,
    fee: X402_FEE,
    note: 'Telegram interactions are free. x402 fees apply to API calls only.',
    transactionType: params.transactionType,
  };
}

/**
 * Get x402 protocol info for the agent
 */
export function getX402Info() {
  return {
    protocol: 'x402',
    version: 1,
    fee: X402_FEE,
    currency: 'cUSD',
    chain: chain.name,
    asset: CUSD_ADDRESS,
    payTo: AGENT_WALLET,
    spec: 'https://github.com/coinbase/x402',
  };
}
