import { getAccountBalance } from '../apis/reloadly';

/**
 * Shared Reloadly account balance cache.
 * Used by API server and MCP tools to cap discovery results
 * so users don't see services above our Reloadly balance.
 *
 * Single cache instance — avoids duplicate fetches across modules.
 */

let balanceCache: { balance: number; fetchedAt: number } | null = null;
const BALANCE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Invalidate after a purchase so next query gets fresh balance */
export function invalidateReloadlyBalanceCache(): void {
  balanceCache = null;
}

export async function getCachedReloadlyBalance(): Promise<number> {
  try {
    if (balanceCache && Date.now() - balanceCache.fetchedAt < BALANCE_CACHE_TTL) {
      return balanceCache.balance;
    }
    const result = await getAccountBalance();
    balanceCache = { balance: result.balance, fetchedAt: Date.now() };
    return result.balance;
  } catch (error) {
    console.error('Failed to fetch Reloadly balance:', error instanceof Error ? error.message : error);
    return balanceCache?.balance ?? 50;
  }
}
