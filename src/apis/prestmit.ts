/**
 * Prestmit API Integration — Gift Card Sell (Card → Fiat → cUSD)
 *
 * Users sell unwanted gift cards and receive cUSD in their Toppa wallet.
 * Prestmit verifies the card, pays out in NAIRA (fiat only via API),
 * and we convert the equivalent to cUSD from our agent wallet.
 *
 * API docs: https://documentation.prestmit.io
 * Sandbox:  https://dev.prestmit.io/api/partners/v1
 * Live:     https://prestmit.io/api/partners/v1
 *
 * Auth: API-KEY + API-Hash (HMAC-SHA256 of payload) on every request
 * Note: Crypto payouts (USDT/BTC) are NOT available via API — fiat only.
 */

import crypto from 'crypto';

const isSandbox = process.env.NODE_ENV !== 'production';
const BASE_URL = isSandbox
  ? 'https://dev.prestmit.io/api/partners/v1'
  : 'https://prestmit.io/api/partners/v1';

const API_KEY = isSandbox
  ? process.env.PRESTMIT_API_KEY_SANDBOX
  : process.env.PRESTMIT_API_KEY;

const API_SECRET = isSandbox
  ? process.env.PRESTMIT_API_SECRET_SANDBOX
  : process.env.PRESTMIT_API_SECRET;

/**
 * Generate HMAC-SHA256 hash for API-Hash header.
 * Prestmit requires this on every request for request integrity.
 */
function generateApiHash(payload: string): string {
  if (!API_SECRET) return '';
  return crypto.createHmac('sha256', API_SECRET).update(payload).digest('hex');
}

// ─── Types ────────────────────────────────────────────────────

export interface PrestmitCategory {
  id: number;
  name: string;
  image: string;
}

export interface PrestmitGiftCard {
  id: number;          // giftcard_id for sell create
  name: string;
  rate: number;        // Exchange rate
  minimum: number;     // Minimum amount
  form: string;        // "Ecode" or "Physical"
  country: string | null;
  terms: string;
  category: PrestmitCategory;
}

export interface PrestmitPayoutMethod {
  name: string;        // "NAIRA" | "CEDIS" | "BITCOINS" | "USDT"
  available: boolean;
  usd_conversion_rate: number | null;
  cedis_naira_conversion_rate: number | null;
  info: string;
}

export interface RateCalculatorData {
  sellableGiftcards: PrestmitGiftCard[];
  sellGiftcardPayoutMethods: PrestmitPayoutMethod[];
  rateConversions: {
    cedisToNairaConvRate: number;
    btcToNairaConvRate: number;
    usdtToNairaConvRate: number;
  };
}

export interface SellTradeResponse {
  reference: string;       // Prestmit's trade reference (e.g., "SGC586326085289")
  rate: number;
  units: string;
  totalAmount: number;     // Payout amount in selected currency
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  comments: string | null;
  rejectionReason: string | null;
  createdAt: string;
  category: PrestmitCategory;
  giftcard: {
    id: number;
    name: string;
    rate: number;
    minimum: number;
    terms: string;
  };
}

export interface WalletBalance {
  balance: number;
  pendingBalance: number;
  totalBalance: number;
  lastUpdated: string;
}

// ─── Base API Call ────────────────────────────────────────────

async function prestmitFetch(path: string, options: RequestInit = {}): Promise<any> {
  if (!API_KEY) {
    throw new Error('Prestmit API key not configured. Set PRESTMIT_API_KEY in .env');
  }

  const url = `${BASE_URL}${path}`;
  // API-Hash is HMAC of the request body (empty string for GET)
  const body = typeof options.body === 'string' ? options.body : '';
  const apiHash = generateApiHash(body);

  const response = await fetch(url, {
    ...options,
    headers: {
      'API-KEY': API_KEY,
      ...(apiHash ? { 'API-Hash': apiHash } : {}),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Prestmit API error ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

// ─── Lookup Endpoints ────────────────────────────────────────

/**
 * Get gift card categories Prestmit accepts for selling
 */
export async function getSellCategories(): Promise<PrestmitCategory[]> {
  const data = await prestmitFetch('/lookup/sell-giftcard-categories');
  return data.data || data;
}

/**
 * Get gift card subcategories (specific card types within a category)
 */
export async function getSellSubcategories(): Promise<PrestmitGiftCard[]> {
  const data = await prestmitFetch('/lookup/sell-giftcard-subcategories');
  return data.data || data;
}

/**
 * Get complete rate calculator data — cards, rates, payout methods, conversions.
 * This is the primary endpoint for displaying sell options to users.
 */
export async function getRateCalculatorData(): Promise<RateCalculatorData> {
  const data = await prestmitFetch('/giftcard-trade/sell/rate-calculator-data');
  return data.data || data;
}

/**
 * Get available payout methods (NAIRA, CEDIS, BITCOINS, USDT)
 */
export async function getPayoutMethods(): Promise<PrestmitPayoutMethod[]> {
  const data = await prestmitFetch('/giftcard-trade/sell/payout-methods');
  return data.data || data;
}

// ─── Sell Trade ──────────────────────────────────────────────

/**
 * Submit a gift card for selling.
 *
 * Uses multipart/form-data as required by Prestmit API.
 *
 * @param giftcardId - Subcategory ID from rate calculator data
 * @param amount - Card face value
 * @param payoutMethod - "NAIRA" | "CEDIS" | "BITCOINS" | "USDT"
 * @param payoutAddress - Required for BITCOINS/USDT — external wallet address
 * @param comments - Optional notes (e.g., card code/PIN)
 * @param uniqueIdentifier - Our internal tracking ID for reconciliation
 */
export async function createSellTrade(params: {
  giftcardId: number;
  amount: number;
  payoutMethod: 'NAIRA' | 'CEDIS' | 'BITCOINS' | 'USDT';
  payoutAddress?: string;
  comments?: string;
  uniqueIdentifier?: string;
}): Promise<SellTradeResponse> {
  if (!API_KEY) {
    throw new Error('Prestmit API key not configured. Set PRESTMIT_API_KEY in .env');
  }

  const formData = new FormData();
  formData.append('giftcard_id', params.giftcardId.toString());
  formData.append('amount', params.amount.toString());
  formData.append('payoutMethod', params.payoutMethod);

  if (params.payoutAddress) {
    formData.append('payoutAddress', params.payoutAddress);
  }
  if (params.comments) {
    formData.append('comments', params.comments);
  }
  if (params.uniqueIdentifier) {
    formData.append('uniqueIdentifier', params.uniqueIdentifier);
  }

  const url = `${BASE_URL}/giftcard-trade/sell/create`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'API-KEY': API_KEY,
      'Accept': 'application/json',
      // Don't set Content-Type — browser/Node sets it with boundary for FormData
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Prestmit sell trade failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.trade || data.data?.trade || data;
}

// ─── Wallet ──────────────────────────────────────────────────

/**
 * Get partner wallet balance (fiat — NAIRA or CEDIS)
 */
export async function getWalletBalance(wallet: 'NAIRA' | 'CEDIS' = 'NAIRA'): Promise<WalletBalance> {
  const data = await prestmitFetch(`/wallet/fiat/details?wallet=${wallet}`);
  return data.data || data;
}

// ─── Legacy Compatibility ────────────────────────────────────
// These functions maintain backward compatibility with existing tools.ts imports

/**
 * Get supported cards for selling — wraps rate calculator data
 */
export async function getSupportedCards(): Promise<PrestmitGiftCard[]> {
  const data = await getRateCalculatorData();
  return data.sellableGiftcards || [];
}

/**
 * Get card rates — alias for rate calculator
 */
export async function getCardRates(_cardId?: number): Promise<RateCalculatorData> {
  return getRateCalculatorData();
}

/**
 * Submit a sell order — wraps createSellTrade with legacy interface
 */
export async function submitSellOrder(params: {
  cardId: number;
  rateId?: number;
  amount: number;
  cardNumber: string;
  cardPin?: string;
  uniqueIdentifier?: string;
}): Promise<SellTradeResponse> {
  const comments = params.cardPin
    ? `Code: ${params.cardNumber} | PIN: ${params.cardPin}`
    : `Code: ${params.cardNumber}`;

  return createSellTrade({
    giftcardId: params.cardId,
    amount: params.amount,
    payoutMethod: 'NAIRA',
    comments,
    uniqueIdentifier: params.uniqueIdentifier,
  });
}

/**
 * Check sell order status by reference
 */
export async function getSellOrderStatus(reference: string): Promise<SellTradeResponse | null> {
  // Prestmit doesn't have a direct status-by-reference endpoint in public docs.
  // Status comes via webhooks or the trades list. Return null to signal "use webhook/poller".
  // If a specific endpoint is available, update this.
  try {
    const data = await prestmitFetch(`/giftcard-trade/sell/${reference}`);
    return data.trade || data.data?.trade || data;
  } catch {
    return null;
  }
}

/**
 * Format cards list for display in agent chat
 */
export function formatCardsList(cards: PrestmitGiftCard[]): string {
  if (cards.length === 0) return 'No gift cards available for selling right now.';

  return cards
    .slice(0, 20)
    .map(card => {
      const category = card.category?.name || '';
      const country = card.country || 'Global';
      return `${card.name} [id:${card.id}] | Rate: ₦${card.rate} | Min: ${card.minimum} | ${country} ${card.form}${category ? ' | ' + category : ''}`;
    })
    .join('\n');
}

// ─── FX Conversion ──────────────────────────────────────────

/**
 * Convert NGN amount to cUSD using a live FX rate (cached 1 hour).
 * Falls back to a conservative estimate if the API is unreachable.
 */
let _cachedNgnRate: { rate: number; fetchedAt: number } | null = null;
const NGN_RATE_CACHE_MS = 60 * 60 * 1000; // 1 hour
const NGN_FALLBACK_RATE = 1600; // Conservative fallback

async function getNgnUsdRate(): Promise<number> {
  if (_cachedNgnRate && Date.now() - _cachedNgnRate.fetchedAt < NGN_RATE_CACHE_MS) {
    return _cachedNgnRate.rate;
  }
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) throw new Error(`FX API ${res.status}`);
    const data = await res.json() as { rates?: { NGN?: number } };
    const rate = data?.rates?.NGN;
    if (rate && rate > 0) {
      _cachedNgnRate = { rate, fetchedAt: Date.now() };
      return rate;
    }
  } catch (err: any) {
    console.error('[FX] Failed to fetch NGN/USD rate:', err.message);
  }
  return _cachedNgnRate?.rate || NGN_FALLBACK_RATE;
}

export async function ngnToCusd(ngnAmount: number): Promise<number> {
  const rate = await getNgnUsdRate();
  return Math.round((ngnAmount / rate) * 100) / 100;
}
