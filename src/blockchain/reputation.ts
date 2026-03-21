import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { PAYMENT_TOKEN_ADDRESS } from './x402.js';

const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as `0x${string}`;
const AGENT_ID = BigInt(process.env.AGENT_ID || '1870');
const API_URL = process.env.API_URL || 'https://api.toppa.cc';

const reputationRegistryAbi = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external',
]);

export interface ReputationFeedback {
  rating: number; // 1-100
  serviceType: 'airtime' | 'data' | 'bill_payment' | 'gift_card';
  success: boolean;
  userPrivateKey: string;
}

/**
 * Auto-submit reputation feedback after service completion
 * Uses cUSD for gas via feeCurrency (Celo mainnet only)
 */
export async function submitAutoReputation(feedback: ReputationFeedback): Promise<string> {
  const userAccount = privateKeyToAccount(feedback.userPrivateKey as `0x${string}`);

  const publicClient = createPublicClient({
    chain: celo,
    transport: http(process.env.CELO_RPC_URL),
  });

  const userWallet = createWalletClient({
    account: userAccount,
    chain: celo,
    transport: http(process.env.CELO_RPC_URL),
  });

  const value = BigInt(feedback.rating); // 1-100 (integer)
  const valueDecimals = 0;
  const tag1 = feedback.serviceType;
  const tag2 = feedback.success ? 'delivered' : 'failed';
  const feedbackURI = '';
  const feedbackHash = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

  const { request } = await publicClient.simulateContract({
    address: REPUTATION_REGISTRY,
    abi: reputationRegistryAbi,
    functionName: 'giveFeedback',
    args: [AGENT_ID, value, valueDecimals, tag1, tag2, API_URL, feedbackURI, feedbackHash],
    account: userAccount,
  });

  // Submit with cUSD as feeCurrency (mainnet only)
  const hash = await userWallet.writeContract({
    ...request,
    feeCurrency: PAYMENT_TOKEN_ADDRESS, // Pay gas in cUSD
  } as any);

  await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

  return hash;
}

/**
 * Calculate rating based on service outcome (1-100 scale)
 */
export function calculateRating(success: boolean, deliveryTimeMs?: number): number {
  if (!success) return 50; // Failed service = 50/100

  if (!deliveryTimeMs) return 100; // No timing data = perfect

  // Fast delivery (< 30s) = 100
  if (deliveryTimeMs < 30000) return 100;

  // Medium delivery (30s - 2min) = 95
  if (deliveryTimeMs < 120000) return 95;

  // Slow delivery (2min+) = 90
  return 90;
}
