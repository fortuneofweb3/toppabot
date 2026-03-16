import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, toHex } from 'viem';
import { celo, celoSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * ERC-8004: Trustless Agents — On-chain identity and reputation on Celo
 *
 * Uses the official ERC-8004 singleton registries deployed on Celo:
 * - Identity Registry: ERC-721 based agent identity (agentId = NFT)
 * - Reputation Registry: Feedback and rating system
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-8004
 */

const isTestnet = process.env.NODE_ENV !== 'production';
const chain = isTestnet ? celoSepolia : celo;

// Official ERC-8004 deployed addresses (vanity prefix 0x8004)
const IDENTITY_REGISTRY = isTestnet
  ? '0x8004A818BFB912233c491871b3d84c89A494BD9e' as `0x${string}` // Celo Sepolia
  : '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as `0x${string}`; // Celo Mainnet

const REPUTATION_REGISTRY = isTestnet
  ? '0x8004B663056A597Dffe9eCcC1965A193B7388713' as `0x${string}` // Celo Sepolia
  : '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as `0x${string}`; // Celo Mainnet

// Identity Registry ABI (from ERC-8004 spec)
const identityRegistryAbi = parseAbi([
  // Registration
  'function register(string agentURI) external returns (uint256)',
  'function register() external returns (uint256)',

  // URI & Metadata
  'function setAgentURI(uint256 agentId, string newURI) external',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes)',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external',

  // Wallet
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature) external',
  'function getAgentWallet(uint256 agentId) external view returns (address)',

  // ERC-721
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',

  // Events
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

// Reputation Registry ABI (from ERC-8004 spec)
const reputationRegistryAbi = parseAbi([
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external',
  'function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external',
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function getClients(uint256 agentId) external view returns (address[])',
  'function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64)',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
]);

// Lazy-initialized clients
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

// In-memory cache of our agent ID (set after registration)
// Using null to distinguish "not set" from 0n (valid agent ID)
let cachedAgentId: bigint | null = null;

/**
 * Toppa's agent registration file — per ERC-8004 spec
 * https://eips.ethereum.org/EIPS/eip-8004#agent-uri-and-agent-registration-file
 *
 * Fields: type, name, description, image, services, x402Support, active, registrations, supportedTrust
 */
export function getAgentRegistrationFile(): object {
  const apiUrl = process.env.API_URL || 'https://toppa.cc';
  const agentId = process.env.AGENT_ID ? parseInt(process.env.AGENT_ID) : null;
  const chainId = isTestnet ? 44787 : 42220;

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Toppa',
    description: 'Financial services AI agent for telecommunications and digital payments. Enables mobile airtime top-ups, data bundles, utility bill payments (electricity, water, internet, TV), and gift card purchases across 170+ countries. Payment infrastructure powered by Celo blockchain stablecoins (cUSD) using the x402 micropayment protocol.',
    image: `${apiUrl}/agent-image.svg`,
    services: [
      {
        name: 'send-airtime',
        description: 'Send mobile airtime top-up (170+ countries, 800+ operators)',
        endpoint: `${apiUrl}/send-airtime`,
        method: 'POST',
        paymentRequired: true,
      },
      {
        name: 'send-data',
        description: 'Send mobile data bundle (170+ countries)',
        endpoint: `${apiUrl}/send-data`,
        method: 'POST',
        paymentRequired: true,
      },
      {
        name: 'pay-bill',
        description: 'Pay utility bill (electricity, water, TV, internet)',
        endpoint: `${apiUrl}/pay-bill`,
        method: 'POST',
        paymentRequired: true,
      },
      {
        name: 'buy-gift-card',
        description: 'Buy gift card (300+ brands: Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, Airbnb)',
        endpoint: `${apiUrl}/buy-gift-card`,
        method: 'POST',
        paymentRequired: true,
      },
      {
        name: 'get-operators',
        description: 'Get mobile operators by country',
        endpoint: `${apiUrl}/operators/:country`,
        method: 'GET',
      },
      {
        name: 'get-data-plans',
        description: 'Get data plan operators by country',
        endpoint: `${apiUrl}/data-plans/:country`,
        method: 'GET',
      },
      {
        name: 'get-billers',
        description: 'Get utility billers by country',
        endpoint: `${apiUrl}/billers/:country`,
        method: 'GET',
      },
      {
        name: 'search-gift-cards',
        description: 'Search gift card brands',
        endpoint: `${apiUrl}/gift-cards/search`,
        method: 'GET',
      },
      {
        name: 'get-countries',
        description: 'Get all supported countries',
        endpoint: `${apiUrl}/countries`,
        method: 'GET',
      },
      {
        name: 'check-transaction',
        description: 'Check transaction status',
        endpoint: `${apiUrl}/transaction/:type/:id`,
        method: 'GET',
      },
    ],
    x402Support: true,
    active: true,
    registrations: agentId !== null ? [
      {
        agentId,
        agentRegistry: `eip155:${chainId}:${IDENTITY_REGISTRY}`,
      },
    ] : [],
    supportedTrust: ['reputation'],
  };
}

function getAgentURI(): string {
  const registrationFile = getAgentRegistrationFile();
  return `data:application/json;base64,${Buffer.from(JSON.stringify(registrationFile)).toString('base64')}`;
}

/**
 * Register Toppa agent on ERC-8004 Identity Registry
 * Mints an NFT representing the agent's on-chain identity
 */
export async function registerAgent() {
  try {
    console.log('Registering Toppa agent on ERC-8004 Identity Registry...');
    console.log(`  Chain: ${chain.name}`);
    console.log(`  Identity Registry: ${IDENTITY_REGISTRY}`);

    const agentURI = getAgentURI();
    const account = getWalletClient().account;

    const { request } = await getPublicClient().simulateContract({
      address: IDENTITY_REGISTRY,
      abi: identityRegistryAbi,
      functionName: 'register',
      args: [agentURI],
      account,
    });

    const hash = await getWalletClient().writeContract(request);
    console.log('  Transaction submitted:', hash);

    const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
    console.log('  Confirmed in block:', receipt.blockNumber);

    // Extract agentId from ERC-721 Transfer event (topics[3] is the tokenId)
    const registeredEvent = receipt.logs.find(
      log => log.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase()
    );
    const agentId = registeredEvent?.topics[3]
      ? BigInt(registeredEvent.topics[3])
      : null;

    if (agentId) {
      cachedAgentId = agentId;
      console.log('  Agent ID:', agentId.toString());
    }

    return {
      agentId: agentId?.toString() || 'unknown',
      transactionHash: hash,
      registered: true,
      blockNumber: Number(receipt.blockNumber),
      chain: chain.name,
      identityRegistry: IDENTITY_REGISTRY,
    };
  } catch (error: any) {
    console.error('Agent registration failed:', error.message);
    return {
      agentId: null,
      registered: false,
      error: error.message,
      note: 'Registration failed — ensure wallet has CELO for gas on ' + chain.name,
    };
  }
}

/**
 * Get or set the agent ID (from env or registration)
 */
function getAgentId(): bigint {
  if (cachedAgentId !== null) return cachedAgentId;
  const envId = process.env.AGENT_ID;
  if (envId && !isNaN(Number(envId))) {
    cachedAgentId = BigInt(envId);
    return cachedAgentId;
  }
  return BigInt(0); // fallback — Toppa's registered ID
}

/**
 * Record a transaction as reputation feedback on ERC-8004
 * Called after each successful service execution
 */
export async function recordTransaction(params: {
  type: string;
  amount: number;
  status: 'success' | 'failed';
  txHash?: string;
  metadata?: any;
}) {
  try {
    const agentId = getAgentId();
    // Rating: 100 = success (1.00 with 2 decimals), 0 = failed
    const value = params.status === 'success' ? BigInt(100) : BigInt(0);
    const valueDecimals = 2;
    const tag1 = params.type; // e.g. 'airtime', 'bill_payment', 'gift_card'
    const tag2 = params.status;
    const endpoint = process.env.API_URL || 'http://localhost:3000';
    const feedbackURI = ''; // Could point to detailed transaction data
    const feedbackHash = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

    const { request } = await getPublicClient().simulateContract({
      address: REPUTATION_REGISTRY,
      abi: reputationRegistryAbi,
      functionName: 'giveFeedback',
      args: [agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash],
      account: getWalletClient().account,
    });

    const hash = await getWalletClient().writeContract(request);
    await getPublicClient().waitForTransactionReceipt({ hash });

    return { recorded: true, transactionHash: hash };
  } catch (error: any) {
    // Don't fail the main operation if reputation recording fails
    console.error('Failed to record on ERC-8004:', error.message);
    return { recorded: false, error: error.message };
  }
}

/**
 * Get agent's reputation summary from ERC-8004 Reputation Registry
 */
export async function getAgentReputation() {
  try {
    const agentId = getAgentId();

    // Get all clients who have given feedback
    const clients = await getPublicClient().readContract({
      address: REPUTATION_REGISTRY,
      abi: reputationRegistryAbi,
      functionName: 'getClients',
      args: [agentId],
    }) as `0x${string}`[];

    // Get summary across all clients
    const [count, summaryValue, summaryValueDecimals] = await getPublicClient().readContract({
      address: REPUTATION_REGISTRY,
      abi: reputationRegistryAbi,
      functionName: 'getSummary',
      args: [agentId, clients, '', ''],
    }) as [bigint, bigint, number];

    const divisor = Math.pow(10, summaryValueDecimals);
    const score = Number(summaryValue) / divisor;

    return {
      agentId: agentId.toString(),
      score,
      totalFeedback: Number(count),
      clients: clients.length,
      chain: chain.name,
      identityRegistry: IDENTITY_REGISTRY,
      reputationRegistry: REPUTATION_REGISTRY,
    };
  } catch (error: any) {
    console.error('Failed to get reputation:', error.message);
    return {
      agentId: getAgentId().toString(),
      score: 0,
      totalFeedback: 0,
      clients: 0,
      chain: chain.name,
      error: error.message,
    };
  }
}

/**
 * Get agent details from Identity Registry
 */
export async function getAgentDetails() {
  try {
    const agentId = getAgentId();

    const [owner, uri, wallet] = await Promise.all([
      getPublicClient().readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryAbi,
        functionName: 'ownerOf',
        args: [agentId],
      }),
      getPublicClient().readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryAbi,
        functionName: 'tokenURI',
        args: [agentId],
      }),
      getPublicClient().readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryAbi,
        functionName: 'getAgentWallet',
        args: [agentId],
      }).catch(() => null),
    ]);

    return {
      agentId: agentId.toString(),
      owner,
      uri,
      wallet,
      chain: chain.name,
    };
  } catch (error: any) {
    console.error('Failed to get agent details:', error.message);
    return null;
  }
}
