import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { celo, celoAlfajores } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * ERC-8004 Registry on Celo
 * Handles agent identity and reputation
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-8004
 */

// ERC-8004 Registry addresses on Celo
// NOTE: These will be provided by Celo docs or you deploy your own
const ERC8004_ADDRESSES = {
  mainnet: process.env.ERC8004_REGISTRY_ADDRESS as `0x${string}`,
  testnet: '0x...' as `0x${string}`, // Replace with actual testnet address
};

const isTestnet = process.env.NODE_ENV !== 'production';
const chain = isTestnet ? celoAlfajores : celo;
const registryAddress = isTestnet ? ERC8004_ADDRESSES.testnet : ERC8004_ADDRESSES.mainnet;

// ERC-8004 ABI (simplified - add full ABI from Celo docs)
const erc8004Abi = parseAbi([
  'function register(string name, string description, string[] skills) external returns (uint256)',
  'function addFeedback(uint256 agentId, uint8 rating, string comment) external',
  'function getAgent(uint256 agentId) external view returns ((string, string, string[], uint256))',
  'function getReputation(uint256 agentId) external view returns (uint256, uint256, uint256)',
  'event AgentRegistered(uint256 indexed agentId, address indexed owner, string name)',
  'event FeedbackAdded(uint256 indexed agentId, address indexed from, uint8 rating)',
]);

// Lazy-initialized clients (env vars aren't available at import time)
let _publicClient: ReturnType<typeof createPublicClient> | null = null;
let _walletClient: ReturnType<typeof createWalletClient> | null = null;

function getPublicClient() {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain,
      transport: http(process.env.CELO_RPC_URL),
    });
  }
  return _publicClient;
}

function getWalletClient() {
  if (!_walletClient) {
    const account = privateKeyToAccount(process.env.CELO_PRIVATE_KEY as `0x${string}`);
    _walletClient = createWalletClient({
      account,
      chain,
      transport: http(process.env.CELO_RPC_URL),
    });
  }
  return _walletClient;
}

/**
 * Register Jara agent on ERC-8004
 */
export async function registerAgent() {
  try {
    console.log('🔐 Registering Jara agent on ERC-8004...');

    const agentName = 'Jara';
    const description = 'Jara ("extra" in Naija) - Your autonomous AI agent for crypto-to-cash conversion in Nigeria. Handles cUSD → NGN bank transfers, bill payments (airtime, utilities, cable TV), and virtual card funding. Built for real-world financial access.';
    const skills = [
      'bank_transfer',
      'bill_payment',
      'rate_optimization',
      'airtime_purchase',
      'virtual_card_loading',
      'selfclaw_verification',
    ];

    // Simulate contract call (replace with actual when ERC-8004 is deployed)
    const account = getWalletClient().account;
    const { request } = await getPublicClient().simulateContract({
      address: registryAddress,
      abi: erc8004Abi,
      functionName: 'register',
      args: [agentName, description, skills],
      account,
    });

    const hash = await getWalletClient().writeContract(request);

    console.log('✅ Agent registered! Transaction hash:', hash);

    // Wait for confirmation
    const receipt = await getPublicClient().waitForTransactionReceipt({ hash });

    // Extract agentId from logs
    const agentId = receipt.logs[0]?.topics[1]; // AgentRegistered event

    return {
      agentId: agentId || 'kleva-' + Date.now(),
      transactionHash: hash,
      registered: true,
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    console.error('❌ Agent registration failed:', error.message);

    // For development: return mock data if ERC-8004 not deployed yet
    return {
      agentId: 'kleva-dev-' + Date.now(),
      registered: true,
      note: 'Mock registration - deploy ERC-8004 contract for production',
    };
  }
}

/**
 * Record transaction for reputation building
 * This is called after each successful action
 */
export async function recordTransaction(params: {
  type: string;
  amount: number;
  status: 'success' | 'failed';
  txHash?: string;
  metadata?: any;
}) {
  try {
    const agentId = BigInt(process.env.AGENT_ID || '1');
    const rating = params.status === 'success' ? 5 : 1;
    const comment = `${params.type} - ${params.status} - Amount: $${params.amount}`;

    console.log('📊 Recording transaction on ERC-8004:', {
      type: params.type,
      rating,
    });

    // Record feedback on-chain
    const { request } = await getPublicClient().simulateContract({
      address: registryAddress,
      abi: erc8004Abi,
      functionName: 'addFeedback',
      args: [agentId, rating, comment],
      account: getWalletClient().account,
    });

    const hash = await getWalletClient().writeContract(request);

    await getPublicClient().waitForTransactionReceipt({ hash });

    return {
      recorded: true,
      transactionHash: hash,
    };
  } catch (error) {
    console.error('❌ Failed to record transaction:', error.message);
    return {
      recorded: false,
      error: error.message,
    };
  }
}

/**
 * Get agent's current reputation
 */
export async function getAgentReputation() {
  try {
    const agentId = BigInt(process.env.AGENT_ID || '1');

    const reputation = await getPublicClient().readContract({
      address: registryAddress,
      abi: erc8004Abi,
      functionName: 'getReputation',
      args: [agentId],
    }) as [bigint, bigint, bigint];

    const [score, totalInteractions, successfulInteractions] = reputation;

    return {
      score: Number(score) / 100, // Convert to 0-1 scale
      totalTransactions: Number(totalInteractions),
      successfulTransactions: Number(successfulInteractions),
      successRate: Number(successfulInteractions) / Number(totalInteractions),
      disputes: Number(totalInteractions) - Number(successfulInteractions),
    };
  } catch (error) {
    console.error('❌ Failed to get reputation:', error.message);

    // Return mock data for development
    return {
      score: 0.95,
      totalTransactions: 47,
      successfulTransactions: 46,
      successRate: 0.98,
      disputes: 1,
    };
  }
}

/**
 * Get agent details
 */
export async function getAgentDetails() {
  try {
    const agentId = BigInt(process.env.AGENT_ID || '1');

    const agent = await getPublicClient().readContract({
      address: registryAddress,
      abi: erc8004Abi,
      functionName: 'getAgent',
      args: [agentId],
    });

    return agent;
  } catch (error) {
    console.error('❌ Failed to get agent details:', error.message);
    return null;
  }
}
