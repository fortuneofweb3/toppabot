/**
 * Relay Protocol Bridge — Cross-chain USDT (Tron) → USDC (Celo)
 *
 * Uses Relay's REST API for cross-chain swaps.
 * Primary use case: Prestmit pays USDT on Tron → bridge to Celo → swap to cUSD.
 *
 * Relay API: https://api.relay.link
 * Docs: https://docs.relay.link
 *
 * Chain IDs:
 *   Tron:  728126428
 *   Celo:  42220
 *
 * Supported bridgeable tokens:
 *   Tron USDT:  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t (6 decimals)
 *   Celo USDC:  0xcebA9300f2b948710d2653dD7B07f33A8B32118C (6 decimals)
 */

const RELAY_API = 'https://api.relay.link';

// Chain IDs
const TRON_CHAIN_ID = 728126428;
const CELO_CHAIN_ID = 42220;

// Token addresses
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const CELO_USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';

export interface RelayQuote {
  estimatedOutput: string;    // Human-readable output amount
  estimatedOutputRaw: string; // Raw output in smallest units
  fees: {
    gas: string;
    relay: string;
    app: string;
  };
  timeEstimate: number;       // Seconds
  steps: any[];               // Executable transaction steps
  requestId: string;
}

export interface BridgeResult {
  requestId: string;
  status: 'pending' | 'success' | 'failure';
  originTxHash?: string;
  destinationTxHash?: string;
}

/**
 * Get a quote for bridging USDT from Tron to USDC on Celo.
 *
 * @param tronAddress - Sender's Tron address (base58 format)
 * @param celoAddress - Recipient's Celo address (0x format)
 * @param amountUsdt - Amount in USDT (human-readable, e.g. "10.5")
 */
export async function getRelayQuote(
  tronAddress: string,
  celoAddress: string,
  amountUsdt: string,
): Promise<RelayQuote> {
  // Convert to smallest units (6 decimals for USDT)
  const amountRaw = Math.round(parseFloat(amountUsdt) * 1e6).toString();

  const res = await fetch(`${RELAY_API}/quote/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: tronAddress,
      originChainId: TRON_CHAIN_ID,
      destinationChainId: CELO_CHAIN_ID,
      originCurrency: TRON_USDT,
      destinationCurrency: CELO_USDC,
      recipient: celoAddress,
      amount: amountRaw,
      tradeType: 'EXACT_INPUT',
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Relay quote failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as any;

  // Extract quote details from response
  const details = data.details || {};
  const fees = data.fees || {};
  const steps = data.steps || [];
  const requestId = steps[0]?.requestId || '';

  return {
    estimatedOutput: details.currencyOut?.amountFormatted || '0',
    estimatedOutputRaw: details.currencyOut?.amount || '0',
    fees: {
      gas: fees.gas?.amountFormatted || '0',
      relay: fees.relayer?.amountFormatted || '0',
      app: fees.app?.amountFormatted || '0',
    },
    timeEstimate: details.timeEstimate || 60,
    steps,
    requestId,
  };
}

/**
 * Check the status of a Relay bridge request.
 *
 * @param requestId - The request ID from the quote/execution
 */
export async function getRelayStatus(requestId: string): Promise<BridgeResult> {
  const res = await fetch(`${RELAY_API}/requests/${requestId}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Relay status check failed (${res.status})`);
  }

  const data = await res.json() as any;
  const status = data.status === 'success' ? 'success'
    : data.status === 'failure' ? 'failure'
    : 'pending';

  return {
    requestId,
    status,
    originTxHash: data.inTxHash,
    destinationTxHash: data.outTxHash,
  };
}

/**
 * Get a human-readable bridge quote for display.
 */
export async function getBridgeQuoteForDisplay(
  tronAddress: string,
  celoAddress: string,
  amountUsdt: string,
): Promise<string> {
  const quote = await getRelayQuote(tronAddress, celoAddress, amountUsdt);
  return [
    `Bridge Quote: ${amountUsdt} USDT (Tron) → ${quote.estimatedOutput} USDC (Celo)`,
    `Fees: gas ${quote.fees.gas}, relay ${quote.fees.relay}`,
    `Estimated time: ~${quote.timeEstimate}s`,
  ].join('\n');
}

export { TRON_CHAIN_ID, CELO_CHAIN_ID, TRON_USDT, CELO_USDC };
