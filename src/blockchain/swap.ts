import {
  createPublicClient, createWalletClient, http, parseAbi,
  formatUnits, parseUnits, type Address,
} from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Uniswap V3 Swap Module — Multi-token support on Celo
 *
 * Supports swapping between any ERC-20 tokens on Celo via Uniswap V3.
 * Primary use case: users deposit any token → auto-swap to cUSD.
 *
 * Uniswap V3 Celo contracts:
 * - SwapRouter02: 0x5615CDAb10dc425a742d643d949a7F474C01abc4
 * - QuoterV2:    0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8
 */

// ── Contract Addresses ─────────────────────────────────────────────────────

const SWAP_ROUTER = '0x5615CDAb10dc425a742d643d949a7F474C01abc4' as Address;
const QUOTER_V2 = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8' as Address;

// ── Supported Tokens on Celo ───────────────────────────────────────────────

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
}

export const SUPPORTED_TOKENS: Record<string, TokenInfo> = {
  cUSD: {
    address: '0x765DE816845861e75A25fCA122bb6898B8B1282a',
    symbol: 'cUSD',
    decimals: 18,
    name: 'Celo Dollar',
  },
  CELO: {
    address: '0x471EcE3750Da237f93B8E339c536989b8978a438',
    symbol: 'CELO',
    decimals: 18,
    name: 'Celo',
  },
  cEUR: {
    address: '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6CA69',
    symbol: 'cEUR',
    decimals: 18,
    name: 'Celo Euro',
  },
  USDC: {
    address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
  },
  USDT: {
    address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
    symbol: 'USDT',
    decimals: 6,
    name: 'Tether USD',
  },
};

// Reverse lookup: address → token info
const TOKEN_BY_ADDRESS = new Map(
  Object.values(SUPPORTED_TOKENS).map(t => [t.address.toLowerCase(), t]),
);

export function getTokenByAddress(address: string): TokenInfo | undefined {
  return TOKEN_BY_ADDRESS.get(address.toLowerCase());
}

export function getTokenBySymbol(symbol: string): TokenInfo | undefined {
  return SUPPORTED_TOKENS[symbol.toUpperCase()];
}

// ── ABIs ───────────────────────────────────────────────────────────────────

const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const swapRouterAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
]);

// ── Clients ────────────────────────────────────────────────────────────────

const publicClient = createPublicClient({
  chain: celo,
  transport: http(process.env.CELO_RPC_URL),
});

// ── Token Balance ──────────────────────────────────────────────────────────

/**
 * Get ERC-20 token balance for an address
 */
export async function getTokenBalance(
  walletAddress: Address,
  tokenAddress: Address,
): Promise<{ raw: bigint; formatted: string; decimals: number }> {
  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [walletAddress],
  });

  const token = getTokenByAddress(tokenAddress);
  const decimals = token?.decimals || 18;

  return {
    raw: balance,
    formatted: formatUnits(balance, decimals),
    decimals,
  };
}

/**
 * Get balances for all supported tokens
 */
export async function getAllBalances(walletAddress: Address): Promise<
  Array<{ symbol: string; balance: string; raw: bigint; address: Address }>
> {
  const results = await Promise.all(
    Object.values(SUPPORTED_TOKENS).map(async (token) => {
      try {
        const { formatted, raw } = await getTokenBalance(walletAddress, token.address);
        return {
          symbol: token.symbol,
          balance: formatted,
          raw,
          address: token.address,
        };
      } catch {
        return {
          symbol: token.symbol,
          balance: '0',
          raw: 0n,
          address: token.address,
        };
      }
    }),
  );

  // Only return tokens with non-zero balance, plus cUSD always
  return results.filter(r => r.raw > 0n || r.symbol === 'cUSD');
}

// ── Quote ──────────────────────────────────────────────────────────────────

// Standard fee tiers for Uniswap V3
const FEE_TIERS = [3000, 500, 10000] as const; // 0.3%, 0.05%, 1%

/**
 * Get a swap quote — returns expected output amount
 */
export async function getQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<{ amountOut: bigint; fee: number }> {
  // Try each fee tier, return the best quote
  let bestQuote: { amountOut: bigint; fee: number } | null = null;

  for (const fee of FEE_TIERS) {
    try {
      const result = await publicClient.readContract({
        address: QUOTER_V2,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn,
          tokenOut,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        }],
      });

      const amountOut = result[0];
      if (!bestQuote || amountOut > bestQuote.amountOut) {
        bestQuote = { amountOut, fee };
      }
    } catch {
      // Fee tier not available for this pair — try next
      continue;
    }
  }

  if (!bestQuote) {
    throw new Error(`No liquidity found for swap ${tokenIn} → ${tokenOut}`);
  }

  return bestQuote;
}

/**
 * Get a human-readable quote with token symbols
 */
export async function getReadableQuote(
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountInHuman: number,
): Promise<{
  amountIn: string;
  amountOut: string;
  tokenIn: string;
  tokenOut: string;
  rate: number;
}> {
  const tokenIn = getTokenBySymbol(tokenInSymbol);
  const tokenOut = getTokenBySymbol(tokenOutSymbol);
  if (!tokenIn) throw new Error(`Unknown token: ${tokenInSymbol}`);
  if (!tokenOut) throw new Error(`Unknown token: ${tokenOutSymbol}`);

  const amountInRaw = parseUnits(amountInHuman.toString(), tokenIn.decimals);
  const { amountOut } = await getQuote(tokenIn.address, tokenOut.address, amountInRaw);

  const amountOutHuman = parseFloat(formatUnits(amountOut, tokenOut.decimals));
  const rate = amountOutHuman / amountInHuman;

  return {
    amountIn: amountInHuman.toFixed(tokenIn.decimals > 6 ? 4 : 2),
    amountOut: amountOutHuman.toFixed(tokenOut.decimals > 6 ? 4 : 2),
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    rate,
  };
}

// ── Swap Execution ─────────────────────────────────────────────────────────

/**
 * Execute a token swap via Uniswap V3 SwapRouter02
 *
 * @param privateKey - User's wallet private key
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param amountIn - Raw amount of input token
 * @param slippageBps - Slippage tolerance in basis points (default 50 = 0.5%)
 * @returns Transaction hash and output amount
 */
export async function executeSwap(
  privateKey: `0x${string}`,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps = 50,
): Promise<{ txHash: string; amountOut: string }> {
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(process.env.CELO_RPC_URL),
  });

  // 1. Get quote for expected output
  const { amountOut: expectedOut, fee } = await getQuote(tokenIn, tokenOut, amountIn);

  // 2. Calculate minimum output with slippage
  const minAmountOut = expectedOut - (expectedOut * BigInt(slippageBps) / 10000n);

  // 3. Check and set approval if needed
  const currentAllowance = await publicClient.readContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, SWAP_ROUTER],
  });

  if (currentAllowance < amountIn) {
    const approveTx = await walletClient.writeContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: 'approve',
      args: [SWAP_ROUTER, amountIn],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 30_000 });
  }

  // 4. Execute swap
  const txHash = await walletClient.writeContract({
    address: SWAP_ROUTER,
    abi: swapRouterAbi,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn,
      tokenOut,
      fee,
      recipient: account.address,
      amountIn,
      amountOutMinimum: minAmountOut,
      sqrtPriceLimitX96: 0n,
    }],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });

  const tokenOutInfo = getTokenByAddress(tokenOut);
  const outDecimals = tokenOutInfo?.decimals || 18;

  return {
    txHash,
    amountOut: formatUnits(expectedOut, outDecimals),
  };
}

/**
 * Swap all of a token to cUSD (convenience function for auto-swap)
 */
export async function swapToCUSD(
  privateKey: `0x${string}`,
  tokenIn: Address,
): Promise<{ txHash: string; amountOut: string } | null> {
  const account = privateKeyToAccount(privateKey);
  const { raw: balance } = await getTokenBalance(account.address, tokenIn);

  if (balance === 0n) return null;

  const cUSD = SUPPORTED_TOKENS.cUSD;
  if (tokenIn.toLowerCase() === cUSD.address.toLowerCase()) return null;

  return executeSwap(privateKey, tokenIn, cUSD.address, balance);
}
