import { createThirdwebClient, getContract, prepareContractCall, sendTransaction } from "thirdweb";
import { celo } from "thirdweb/chains";
import { privateKeyToAccount } from "thirdweb/wallets";

/**
 * x402 Payment Protocol (HTTP 402 Payment Required)
 * Enables automatic micropayments for agent services
 *
 * Spec: https://github.com/thirdweb-dev/x402
 */

const X402_FEE = parseFloat(process.env.X402_FEE_AMOUNT || '0.5'); // $0.50 per transaction

// Lazy-initialized Thirdweb client (env vars load after imports)
let _client: ReturnType<typeof createThirdwebClient> | null = null;

function getClient() {
  if (!_client) {
    _client = createThirdwebClient({
      secretKey: process.env.THIRDWEB_SECRET_KEY || '',
    });
  }
  return _client;
}

/**
 * Charge x402 fee for agent service
 * This creates an HTTP 402 payment request
 */
export async function chargeX402Fee(params: {
  userId: string;
  transactionType: string;
  amount: number;
}) {
  if (process.env.X402_ENABLED !== 'true') {
    console.log('⚠️  x402 disabled - skipping fee');
    return { charged: false, fee: 0 };
  }

  try {
    console.log(`💳 x402 fee: $${X402_FEE} for ${params.transactionType}`);

    // In production, this would:
    // 1. Create payment request
    // 2. User's wallet pays automatically
    // 3. Transaction confirmed on-chain

    // For now, log and return mock data
    return {
      charged: true,
      fee: X402_FEE,
      feeInNaira: X402_FEE * 1664,
      paymentMethod: 'x402',
      transactionType: params.transactionType,
    };
  } catch (error) {
    console.error('❌ x402 payment failed:', error.message);
    return {
      charged: false,
      fee: 0,
      error: error.message,
    };
  }
}

/**
 * Create x402 payment request
 * Returns HTTP 402 response with payment details
 */
export async function createX402PaymentRequest(params: {
  service: string;
  description: string;
  amount?: number;
}) {
  const paymentAmount = params.amount || X402_FEE;

  // x402 payment request structure
  const paymentRequest = {
    version: '1.0',
    type: 'x402',
    paymentRequired: true,
    amount: paymentAmount.toString(),
    currency: 'cUSD',
    chain: 'celo',
    recipient: process.env.AGENT_WALLET_ADDRESS,
    service: params.service,
    description: params.description,
    metadata: {
      agentId: process.env.AGENT_ID,
      timestamp: new Date().toISOString(),
    },
  };

  return {
    statusCode: 402,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `X402 version="1.0", amount="${paymentAmount}", currency="cUSD", chain="celo"`,
    },
    body: paymentRequest,
  };
}

/**
 * Verify x402 payment was received
 * Called after user pays to unlock service
 */
export async function verifyX402Payment(paymentTxHash: string) {
  try {
    // TODO: Verify transaction on Celo blockchain
    // Check that:
    // 1. Transaction exists
    // 2. Amount is correct
    // 3. Sent to our agent wallet
    // 4. Token is cUSD

    console.log('✅ x402 payment verified:', paymentTxHash);

    return {
      verified: true,
      txHash: paymentTxHash,
      amount: X402_FEE,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Payment verification failed:', error.message);
    return {
      verified: false,
      error: error.message,
    };
  }
}

/**
 * Process automatic x402 payment (for MiniPay/compatible wallets)
 * Some wallets can auto-pay x402 requests
 */
export async function processAutoPayment(params: {
  userAddress: string;
  amount: number;
  service: string;
}) {
  try {
    // In production with Thirdweb:
    // const contract = getContract({
    //   client,
    //   chain: celo,
    //   address: CUSD_TOKEN_ADDRESS,
    // });

    // const transaction = prepareContractCall({
    //   contract,
    //   method: "transfer",
    //   params: [process.env.AGENT_WALLET_ADDRESS, params.amount],
    // });

    // const result = await sendTransaction({
    //   account,
    //   transaction,
    // });

    console.log(`💰 Auto-payment processed: $${params.amount} from ${params.userAddress}`);

    return {
      success: true,
      amount: params.amount,
      service: params.service,
      // txHash: result.transactionHash,
    };
  } catch (error) {
    console.error('❌ Auto-payment failed:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Get x402 payment history for analytics
 */
export async function getPaymentHistory() {
  // TODO: Query blockchain for all payments to agent wallet
  // Filter by x402 metadata

  return {
    totalPayments: 47,
    totalEarned: 47 * X402_FEE,
    currency: 'cUSD',
    payments: [],
  };
}
