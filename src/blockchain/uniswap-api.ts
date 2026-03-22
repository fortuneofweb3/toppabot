/**
 * Uniswap Trading API Integration
 *
 * Uses Uniswap's official Trading API for optimized swap routing.
 * Falls back to direct SwapRouter02 contract calls if API is unavailable.
 *
 * Trading API: https://trade-api.gateway.uniswap.org/v1
 * Docs: https://docs.uniswap.org/api/trading/overview
 *
 * Benefits over direct contract calls:
 * - Automatic route optimization (multi-hop, split routes)
 * - Better pricing via aggregated liquidity
 * - Gas estimation and calldata generation
 * - Supports Universal Router (more gas-efficient)
 */

import {
  createPublicClient, createWalletClient, http, parseAbi,
  formatUnits, parseUnits, type Address,
} from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { SUPPORTED_TOKENS, getTokenBySymbol, getTokenByAddress, executeSwap as directSwap } from './swap';

const TRADING_API_BASE = 'https://trade-api.gateway.uniswap.org/v1';
const UNISWAP_API_KEY = process.env.UNISWAP_API_KEY || '';
const CELO_CHAIN_ID = 42220;

// Universal Router on Celo
const UNIVERSAL_ROUTER = '0x643770E279d5D0733F21d6DC03A8efbABf3255B4' as Address;

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const publicClient = createPublicClient({
  chain: celo,
  transport: http(process.env.CELO_RPC_URL),
});

// ── Types ─────────────────────────────────────────────────────────────────

interface QuoteResponse {
  quote: {
    input: { token: string; amount: string };
    output: { token: string; amount: string };
    swapper: string;
    route: any[];
  };
  permitData?: any;
  routing: string;
}

interface SwapResponse {
  swap: {
    to: string;
    data: string;
    value: string;
    gasLimit: string;
  };
  quote: QuoteResponse['quote'];
}

// ── Quote via Trading API ─────────────────────────────────────────────────

/**
 * Get a swap quote from Uniswap Trading API.
 * Returns optimized routing with expected output amount.
 */
export async function getApiQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  swapperAddress: Address,
): Promise<{
  amountOut: bigint;
  amountOutFormatted: string;
  route: string;
  gasEstimate?: string;
} | null> {
  if (!UNISWAP_API_KEY) return null;

  try {
    const tokenInInfo = getTokenByAddress(tokenIn);
    const tokenOutInfo = getTokenByAddress(tokenOut);

    const response = await fetch(`${TRADING_API_BASE}/quote`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': UNISWAP_API_KEY,
      },
      body: JSON.stringify({
        tokenIn: tokenIn,
        tokenInChainId: CELO_CHAIN_ID,
        tokenOut: tokenOut,
        tokenOutChainId: CELO_CHAIN_ID,
        amount: amountIn.toString(),
        type: 'EXACT_INPUT',
        swapper: swapperAddress,
        slippageTolerance: 0.5,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[Uniswap API] Quote failed: ${response.status}`);
      return null;
    }

    const data = await response.json() as QuoteResponse;
    const outputAmount = BigInt(data.quote.output.amount);
    const outDecimals = tokenOutInfo?.decimals || 18;

    return {
      amountOut: outputAmount,
      amountOutFormatted: formatUnits(outputAmount, outDecimals),
      route: data.routing || 'CLASSIC',
      gasEstimate: undefined,
    };
  } catch (err: any) {
    console.warn(`[Uniswap API] Quote error: ${err.message}`);
    return null;
  }
}

// ── Swap via Trading API ──────────────────────────────────────────────────

/**
 * Execute a swap using Uniswap Trading API.
 * The API returns calldata for the Universal Router — we just sign and send.
 *
 * Falls back to direct SwapRouter02 if API is unavailable.
 */
export async function executeApiSwap(
  privateKey: `0x${string}`,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps = 50,
): Promise<{ txHash: string; amountOut: string; source: 'api' | 'direct' }> {
  const account = privateKeyToAccount(privateKey);

  // Try Trading API first
  if (UNISWAP_API_KEY) {
    try {
      const response = await fetch(`${TRADING_API_BASE}/swap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': UNISWAP_API_KEY,
        },
        body: JSON.stringify({
          tokenIn: tokenIn,
          tokenInChainId: CELO_CHAIN_ID,
          tokenOut: tokenOut,
          tokenOutChainId: CELO_CHAIN_ID,
          amount: amountIn.toString(),
          type: 'EXACT_INPUT',
          swapper: account.address,
          slippageTolerance: slippageBps / 100,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (response.ok) {
        const data = await response.json() as SwapResponse;

        // Approve Universal Router if needed
        const currentAllowance = await publicClient.readContract({
          address: tokenIn,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [account.address, UNIVERSAL_ROUTER],
        });

        const walletClient = createWalletClient({
          account,
          chain: celo,
          transport: http(process.env.CELO_RPC_URL),
        });

        if (currentAllowance < amountIn) {
          const approveTx = await walletClient.writeContract({
            address: tokenIn,
            abi: erc20Abi,
            functionName: 'approve',
            args: [UNIVERSAL_ROUTER, amountIn],
          });
          await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 30_000 });
        }

        // Send the swap transaction using calldata from API
        const txHash = await walletClient.sendTransaction({
          to: data.swap.to as Address,
          data: data.swap.data as `0x${string}`,
          value: BigInt(data.swap.value || '0'),
          gas: data.swap.gasLimit ? BigInt(data.swap.gasLimit) : undefined,
        });

        await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });

        const tokenOutInfo = getTokenByAddress(tokenOut);
        const outDecimals = tokenOutInfo?.decimals || 18;

        console.log(`[Uniswap API] Swap executed via Trading API: ${txHash}`);

        return {
          txHash,
          amountOut: formatUnits(BigInt(data.quote.output.amount), outDecimals),
          source: 'api',
        };
      }

      console.warn(`[Uniswap API] Swap endpoint returned ${response.status}, falling back to direct`);
    } catch (err: any) {
      console.warn(`[Uniswap API] Swap error: ${err.message}, falling back to direct`);
    }
  }

  // Fallback to direct SwapRouter02 contract calls
  console.log(`[Uniswap] Using direct SwapRouter02 contract calls`);
  const result = await directSwap(privateKey, tokenIn, tokenOut, amountIn, slippageBps);
  return { ...result, source: 'direct' };
}

// ── Convenience: Swap to cUSD via API ─────────────────────────────────────

/**
 * Swap entire balance of a token to cUSD, preferring Trading API.
 */
export async function swapToCUSDViaApi(
  privateKey: `0x${string}`,
  tokenIn: Address,
): Promise<{ txHash: string; amountOut: string; source: 'api' | 'direct' } | null> {
  const account = privateKeyToAccount(privateKey);

  const balance = await publicClient.readContract({
    address: tokenIn,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [account.address],
  });

  if (balance === 0n) return null;

  const cUSD = SUPPORTED_TOKENS.cUSD;
  if (tokenIn.toLowerCase() === cUSD.address.toLowerCase()) return null;

  return executeApiSwap(privateKey, tokenIn, cUSD.address, balance);
}

// ── Human-readable quote (prefers API) ────────────────────────────────────

/**
 * Get a human-readable swap quote, preferring the Trading API for better pricing.
 */
export async function getApiReadableQuote(
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountInHuman: number,
  swapperAddress?: Address,
): Promise<{
  amountIn: string;
  amountOut: string;
  tokenIn: string;
  tokenOut: string;
  rate: number;
  source: 'api' | 'direct';
}> {
  const tokenIn = getTokenBySymbol(tokenInSymbol);
  const tokenOut = getTokenBySymbol(tokenOutSymbol);
  if (!tokenIn) throw new Error(`Unknown token: ${tokenInSymbol}`);
  if (!tokenOut) throw new Error(`Unknown token: ${tokenOutSymbol}`);

  const amountInRaw = parseUnits(amountInHuman.toString(), tokenIn.decimals);

  // Try API quote first
  if (UNISWAP_API_KEY && swapperAddress) {
    const apiQuote = await getApiQuote(tokenIn.address, tokenOut.address, amountInRaw, swapperAddress);
    if (apiQuote) {
      const amountOutHuman = parseFloat(apiQuote.amountOutFormatted);
      return {
        amountIn: amountInHuman.toFixed(tokenIn.decimals > 6 ? 4 : 2),
        amountOut: amountOutHuman.toFixed(tokenOut.decimals > 6 ? 4 : 2),
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        rate: amountOutHuman / amountInHuman,
        source: 'api',
      };
    }
  }

  // Fallback to direct contract quote
  const { getReadableQuote } = await import('./swap');
  const quote = await getReadableQuote(tokenInSymbol, tokenOutSymbol, amountInHuman);
  return { ...quote, source: 'direct' };
}
