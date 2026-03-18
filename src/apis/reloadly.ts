/**
 * Reloadly API - Digital goods: Airtime, Data, Gift Cards, Utility Bills
 *
 * Sandbox: Free, no real money. Use for demo.
 * Production: Pre-funded USD business wallet.
 *
 * Covers 170+ countries, 800+ operators, 300+ gift card brands (14,000+ products).
 *
 * Discovery results are globally cached (see api-cache.ts) so repeated requests
 * across users are instant. Only transactions and balance are always fresh.
 */

import { apiCache, CACHE_TTL } from '../shared/api-cache';
import { sanitizePhone } from '../shared/sanitize';

const isProduction = process.env.NODE_ENV === 'production';

const AIRTIME_BASE_URL = isProduction
  ? 'https://topups.reloadly.com'
  : 'https://topups-sandbox.reloadly.com';

const UTILITIES_BASE_URL = isProduction
  ? 'https://utilities.reloadly.com'
  : 'https://utilities-sandbox.reloadly.com';

const GIFTCARDS_BASE_URL = isProduction
  ? 'https://giftcards.reloadly.com'
  : 'https://giftcards-sandbox.reloadly.com';

const AUTH_URL = 'https://auth.reloadly.com/oauth/token';

const CLIENT_ID = isProduction
  ? (process.env.RELOADLY_CLIENT_ID || '')
  : (process.env.RELOADLY_CLIENT_ID_SANDBOX || process.env.RELOADLY_CLIENT_ID || '');
const CLIENT_SECRET = isProduction
  ? (process.env.RELOADLY_CLIENT_SECRET || '')
  : (process.env.RELOADLY_CLIENT_SECRET_SANDBOX || process.env.RELOADLY_CLIENT_SECRET || '');

/**
 * Reloadly error with structured error code
 */
export class ReloadlyError extends Error {
  code: string;
  httpStatus: number;

  constructor(message: string, code: string, httpStatus: number) {
    super(message);
    this.name = 'ReloadlyError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Parse Reloadly API error response into a structured ReloadlyError
 */
function parseReloadlyError(status: number, body: any): ReloadlyError {
  const errorCode = body?.errorCode || body?.error || 'UNKNOWN_ERROR';
  const message = body?.message || body?.error_description || `Request failed: ${status}`;
  return new ReloadlyError(message, errorCode, status);
}

// Token cache per product
let airtimeToken: { token: string; expiresAt: number } | null = null;
let utilitiesToken: { token: string; expiresAt: number } | null = null;
let giftcardsToken: { token: string; expiresAt: number } | null = null;

// ─── Auth ───

async function getToken(product: 'airtime' | 'utilities' | 'giftcards'): Promise<string> {
  const cached = product === 'airtime' ? airtimeToken : product === 'utilities' ? utilitiesToken : giftcardsToken;
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const audience = product === 'airtime' ? AIRTIME_BASE_URL
    : product === 'utilities' ? UTILITIES_BASE_URL
    : GIFTCARDS_BASE_URL;

  const response = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
      audience,
    }),
  });

  if (!response.ok) {
    throw new Error(`Reloadly auth failed: ${response.status}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  const tokenData = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000,
  };

  if (product === 'airtime') {
    airtimeToken = tokenData;
  } else if (product === 'utilities') {
    utilitiesToken = tokenData;
  } else {
    giftcardsToken = tokenData;
  }

  return tokenData.token;
}

/**
 * Retry wrapper with exponential backoff for transient failures.
 * Retries on: network errors, timeouts, 429, 500, 502, 503, 504.
 * Does NOT retry on: 400, 401, 403, 404 (client errors).
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = (
        error.name === 'AbortError' ||
        error.name === 'FetchError' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        (error instanceof ReloadlyError && [401, 429, 500, 502, 503, 504].includes(error.httpStatus))
      );

      if (isLastAttempt || !isRetryable) throw error;

      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      console.warn(`[Reloadly] Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${error.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

/** Invalidate a cached token (called on 401 to force refresh) */
function invalidateToken(product: 'airtime' | 'utilities' | 'giftcards') {
  if (product === 'airtime') airtimeToken = null;
  else if (product === 'utilities') utilitiesToken = null;
  else giftcardsToken = null;
}

// Product-specific config for the unified request function
const PRODUCT_CONFIG = {
  airtime: { baseUrl: AIRTIME_BASE_URL, accept: 'application/com.reloadly.topups-v1+json' },
  utilities: { baseUrl: UTILITIES_BASE_URL, accept: undefined },
  giftcards: { baseUrl: GIFTCARDS_BASE_URL, accept: 'application/com.reloadly.giftcards-v1+json' },
} as const;

async function reloadlyRequest<T>(
  product: 'airtime' | 'utilities' | 'giftcards',
  method: 'GET' | 'POST',
  path: string,
  body?: any,
): Promise<T> {
  const { baseUrl, accept } = PRODUCT_CONFIG[product];

  return withRetry(async () => {
    const token = await getToken(product);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (accept) headers['Accept'] = accept;

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 401) {
      invalidateToken(product);
    }

    if (!response.ok) {
      try {
        const err = await response.json();
        throw parseReloadlyError(response.status, err);
      } catch (e) {
        if (e instanceof ReloadlyError) throw e;
        throw new ReloadlyError(`Request failed: ${response.status}`, 'UNKNOWN_ERROR', response.status);
      }
    }

    return response.json() as Promise<T>;
  });
}

// Convenience aliases
const airtimeRequest = <T>(method: 'GET' | 'POST', path: string, body?: any) =>
  reloadlyRequest<T>('airtime', method, path, body);
const utilitiesRequest = <T>(method: 'GET' | 'POST', path: string, body?: any) =>
  reloadlyRequest<T>('utilities', method, path, body);
const giftcardsRequest = <T>(method: 'GET' | 'POST', path: string, body?: any) =>
  reloadlyRequest<T>('giftcards', method, path, body);

// ─── Types ───

export interface ReloadlyOperator {
  id: number;
  operatorId: number;
  name: string;
  bundle: boolean;
  data: boolean;
  pin: boolean;
  denominationType: 'RANGE' | 'FIXED';
  senderCurrencyCode: string;
  senderCurrencySymbol: string;
  destinationCurrencyCode: string;
  destinationCurrencySymbol: string;
  minAmount: number;
  maxAmount: number;
  localMinAmount: number;
  localMaxAmount: number;
  fixedAmounts: number[] | null;
  fixedAmountsDescriptions: Record<string, string> | null;
  localFixedAmounts: number[] | null;
  localFixedAmountsDescriptions: Record<string, string> | null;
  suggestedAmounts: number[] | null;
  suggestedAmountsMap: Record<string, number> | null;
  mostPopularAmount: number | null;
  mostPopularLocalAmount: number | null;
  supportsLocalAmounts: boolean;
  internationalDiscount: number;
  localDiscount: number;
  commission: number;
  logoUrls: string[];
  promotions: any[];
  status: string;
  country: { isoName: string; name: string };
  fx: { rate: number; currencyCode: string };
}

export interface ReloadlyTopupResponse {
  transactionId: number;
  status: string;
  operatorTransactionId: string;
  customIdentifier: string;
  recipientPhone: string;
  countryCode: string;
  operatorId: number;
  operatorName: string;
  requestedAmount: number;
  requestedAmountCurrencyCode: string;
  deliveredAmount: number;
  deliveredAmountCurrencyCode: string;
  discount: number;
  discountCurrencyCode: string;
  transactionDate: string;
  pinDetail: {
    serial: number;
    info1: string;
    info2: string;
    info3: string;
    value: string | null;
    code: number;
    ivr: string;
    validity: string;
  } | null;
  balanceInfo: {
    oldBalance: number;
    newBalance: number;
    cost: number;
    currencyCode: string;
  };
}

export interface ReloadlyBiller {
  id: number;
  name: string;
  countryCode: string;
  countryName: string;
  type: string;
  serviceType: string;
  localAmountSupported: boolean;
  localTransactionCurrencyCode: string;
  minLocalTransactionAmount: number;
  maxLocalTransactionAmount: number;
  localTransactionFee: number;
  localTransactionFeeCurrencyCode: string;
  localDiscountPercentage: number;
  internationalAmountSupported: boolean;
  internationalTransactionCurrencyCode: string;
  minInternationalTransactionAmount: number;
  maxInternationalTransactionAmount: number;
  internationalTransactionFee: number;
  internationalTransactionFeeCurrencyCode: string;
  internationalDiscountPercentage: number;
  fx: { rate: number; currencyCode: string };
}

export interface ReloadlyBillPaymentResponse {
  id: number;
  status: string;
  referenceId: string;
  code: string;
  message: string;
  submittedAt: string;
  finalStatusAvailabilityAt: string | null;
}

// ─── Airtime Functions ───

/**
 * Get mobile operators for a country
 */
export async function getOperators(countryCode: string) {
  const cc = countryCode.toUpperCase();
  const cacheKey = `operators:${cc}`;
  const cached = apiCache.get<ReloadlyOperator[]>(cacheKey);
  if (cached) return cached;

  const result = await airtimeRequest<ReloadlyOperator[]>('GET', `/operators/countries/${cc}`);
  apiCache.set(cacheKey, result, CACHE_TTL.OPERATORS);
  return result;
}

/**
 * Auto-detect operator from phone number
 */
export async function detectOperator(phone: string, countryCode: string) {
  const sanitized = sanitizePhone(phone);
  const cc = countryCode.toUpperCase();
  const cacheKey = `detect:${sanitized}:${cc}`;
  const cached = apiCache.get<ReloadlyOperator>(cacheKey);
  if (cached) return cached;

  const result = await airtimeRequest<ReloadlyOperator>('GET', `/operators/auto-detect/phone/${encodeURIComponent(sanitized)}/countries/${cc}`);
  apiCache.set(cacheKey, result, CACHE_TTL.DETECT_OPERATOR);
  return result;
}

/**
 * Send airtime top-up
 */
export async function sendAirtime(params: {
  phone: string;
  countryCode: string;
  amount: number;
  operatorId?: number;
  useLocalAmount?: boolean;
}) {
  const sanitizedPhone = sanitizePhone(params.phone);

  // Auto-detect operator if not provided
  let operatorId = params.operatorId;
  if (!operatorId) {
    const operator = await detectOperator(sanitizedPhone, params.countryCode);
    operatorId = operator.operatorId;
  }

  return airtimeRequest<ReloadlyTopupResponse>('POST', '/topups', {
    operatorId,
    amount: params.amount,
    useLocalAmount: params.useLocalAmount ?? false,
    customIdentifier: `toppa-${Date.now()}`,
    recipientPhone: {
      countryCode: params.countryCode.toUpperCase(),
      number: sanitizedPhone,
    },
  });
}

// ─── Data Plan Functions ───

/**
 * Get data plan operators for a country
 * Filters operators that specifically offer data bundles
 */
export async function getDataOperators(countryCode: string) {
  const allOperators = await getOperators(countryCode);
  return allOperators.filter(op => op.data || op.bundle);
}

/**
 * Send data bundle top-up
 * Same mechanism as airtime but uses data-specific operators
 */
export async function sendData(params: {
  phone: string;
  countryCode: string;
  amount: number;
  operatorId: number; // Required — must be a data operator
  useLocalAmount?: boolean;
}) {
  const sanitizedPhone = sanitizePhone(params.phone);

  return airtimeRequest<ReloadlyTopupResponse>('POST', '/topups', {
    operatorId: params.operatorId,
    amount: params.amount,
    useLocalAmount: params.useLocalAmount ?? false,
    customIdentifier: `toppa-data-${Date.now()}`,
    recipientPhone: {
      countryCode: params.countryCode.toUpperCase(),
      number: sanitizedPhone,
    },
  });
}

// ─── Utility Bill Functions ───

/**
 * Get billers for a country and type
 */
export async function getBillers(params: {
  countryCode: string;
  type?: 'ELECTRICITY_BILL_PAYMENT' | 'WATER_BILL_PAYMENT' | 'TV_BILL_PAYMENT' | 'INTERNET_BILL_PAYMENT';
}) {
  const cc = params.countryCode.toUpperCase();
  const cacheKey = `billers:${cc}:${params.type || 'ALL'}`;
  const cached = apiCache.get<ReloadlyBiller[]>(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams({
    countryISOCode: cc,
    page: '0',
    size: '200',
  });
  if (params.type) {
    query.set('type', params.type);
  }

  // Reloadly utilities API returns paginated response {content: [...]}
  const response = await utilitiesRequest<{ content: ReloadlyBiller[] } | ReloadlyBiller[]>(
    'GET',
    `/billers?${query.toString()}`
  );

  // Handle both paginated and array responses
  const result = Array.isArray(response) ? response : (response && 'content' in response ? response.content : []);
  apiCache.set(cacheKey, result, CACHE_TTL.BILLERS);
  return result;
}

/**
 * Pay a utility bill
 */
export async function payBill(params: {
  billerId: number;
  accountNumber: string;
  amount: number;
  useLocalAmount?: boolean;
}) {
  return utilitiesRequest<ReloadlyBillPaymentResponse>('POST', '/pay', {
    subscriberAccountNumber: params.accountNumber,
    amount: params.amount,
    billerId: params.billerId,
    useLocalAmount: params.useLocalAmount ?? false,
    referenceId: `toppa-bill-${Date.now()}`,
  });
}

// ─── Gift Card Types ───

export interface ReloadlyGiftCardProduct {
  productId: number;
  productName: string;
  global: boolean;
  senderCurrencyCode: string;
  recipientCurrencyCode: string;
  senderFee: number;
  senderFeePercentage: number;
  discountPercentage: number;
  denominationType: 'FIXED' | 'RANGE';
  fixedRecipientDenominations: number[];
  fixedSenderDenominations: number[];
  fixedRecipientToSenderDenominationsMap: Record<string, number> | null;
  minRecipientDenomination: number | null;
  maxRecipientDenomination: number | null;
  minSenderDenomination: number | null;
  maxSenderDenomination: number | null;
  brand: {
    brandId: number;
    brandName: string;
  };
  category: {
    id: number;
    name: string;
  };
  country: {
    isoName: string;
    name: string;
    flagUrl: string;
  };
  logoUrls: string[];
  redeemInstruction: {
    concise: string;
    verbose: string;
  };
  status: string;
}

export interface ReloadlyGiftCardOrderResponse {
  transactionId: number;
  amount: number;
  discount: number;
  currencyCode: string;
  fee: number;
  recipientEmail: string;
  status: string;
  product: {
    productId: number;
    productName: string;
    brand: { brandId: number; brandName: string };
    country: { isoName: string; name: string };
  };
  transactionCreatedTime: string;
}

export interface ReloadlyGiftCardRedeemCode {
  cardNumber: string;
  pinCode: string;
}

// ─── Gift Card Functions ───

/**
 * Get gift card products for a country
 */
export async function getGiftCardProducts(countryCode: string) {
  const cc = countryCode.toUpperCase();
  const cacheKey = `giftcards:${cc}`;
  const cached = apiCache.get<ReloadlyGiftCardProduct[]>(cacheKey);
  if (cached) return cached;

  const result = await giftcardsRequest<ReloadlyGiftCardProduct[]>('GET', `/countries/${cc}/products`);
  apiCache.set(cacheKey, result, CACHE_TTL.GIFT_CARDS);
  return result;
}

/**
 * Search gift card products by name
 */
export async function searchGiftCards(query: string, countryCode?: string) {
  let products: ReloadlyGiftCardProduct[];

  if (countryCode) {
    // getGiftCardProducts is already cached
    products = await getGiftCardProducts(countryCode);
  } else {
    // Global product list — cache it separately
    const globalKey = 'giftcards:GLOBAL';
    const cached = apiCache.get<ReloadlyGiftCardProduct[]>(globalKey);
    if (cached) {
      products = cached;
    } else {
      const response = await giftcardsRequest<ReloadlyGiftCardProduct[] | { content: ReloadlyGiftCardProduct[] }>(
        'GET',
        '/products?size=200'
      );
      products = Array.isArray(response) ? response : (response?.content || []);
      apiCache.set(globalKey, products, CACHE_TTL.SEARCH);
    }
  }

  const lowerQuery = query.toLowerCase();
  return products.filter(p =>
    p.productName.toLowerCase().includes(lowerQuery) ||
    p.brand.brandName.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Get a specific gift card product by ID
 */
export async function getGiftCardProduct(productId: number) {
  return giftcardsRequest<ReloadlyGiftCardProduct>('GET', `/products/${productId}`);
}

/**
 * Buy a gift card
 */
export async function buyGiftCard(params: {
  productId: number;
  quantity: number;
  unitPrice: number;
  recipientEmail: string;
  senderName?: string;
}) {
  return giftcardsRequest<ReloadlyGiftCardOrderResponse>('POST', '/orders', {
    productId: params.productId,
    quantity: params.quantity,
    unitPrice: params.unitPrice,
    customIdentifier: `toppa-gc-${Date.now()}`,
    recipientEmail: params.recipientEmail,
    senderName: params.senderName || 'Toppa Agent',
  });
}

/**
 * Get redeem codes for a purchased gift card
 */
export async function getGiftCardRedeemCode(transactionId: number) {
  return giftcardsRequest<ReloadlyGiftCardRedeemCode[]>(
    'GET',
    `/orders/transactions/${transactionId}/cards`
  );
}

// ─── Info / Discovery Functions ───

export interface ReloadlyCountry {
  isoName: string;
  name: string;
  currencyCode: string;
  currencyName: string;
  currencySymbol: string;
  flag: string;
  callingCodes: string[];
}

/**
 * Get all supported countries (from airtime API)
 */
export async function getCountries() {
  const cacheKey = 'countries:ALL';
  const cached = apiCache.get<ReloadlyCountry[]>(cacheKey);
  if (cached) return cached;

  const result = await airtimeRequest<ReloadlyCountry[]>('GET', '/countries');
  apiCache.set(cacheKey, result, CACHE_TTL.OPERATORS); // Country data rarely changes — 30 min TTL
  return result;
}

/**
 * Get Reloadly account balance
 */
export async function getAccountBalance() {
  return airtimeRequest<{ balance: number; currencyCode: string; currencyName: string; updatedAt: string }>(
    'GET',
    '/accounts/balance'
  );
}

/**
 * Get promotions (active operator deals/bonuses)
 */
export async function getPromotions(countryCode?: string) {
  const cc = countryCode?.toUpperCase() || 'GLOBAL';
  const cacheKey = `promotions:${cc}`;
  const cached = apiCache.get<any[]>(cacheKey);
  if (cached) return cached;

  const path = countryCode
    ? `/promotions/country-codes/${cc}`
    : '/promotions?page=0&size=50';

  const response = await airtimeRequest<any>('GET', path);

  // Handle paginated or array response
  const result = Array.isArray(response) ? response : (response?.content || []);
  apiCache.set(cacheKey, result, CACHE_TTL.PROMOTIONS);
  return result;
}

/**
 * Get airtime transaction status by ID
 */
export async function getAirtimeTransaction(transactionId: number) {
  return airtimeRequest<any>('GET', `/topups/reports/transactions/${transactionId}`);
}

/**
 * Get utility bill transaction status by ID
 */
export async function getBillTransaction(transactionId: number) {
  return utilitiesRequest<any>('GET', `/transactions/${transactionId}`);
}

/**
 * Get a full country service summary (what's available)
 * Calls operators, billers, and gift cards in parallel
 */
export async function getCountryServices(countryCode: string) {
  const cc = countryCode.toUpperCase();

  const [operators, billers, giftCards] = await Promise.allSettled([
    getOperators(cc),
    getBillers({ countryCode: cc }),
    getGiftCardProducts(cc),
  ]);

  const ops = operators.status === 'fulfilled' ? operators.value : [];
  const bills = billers.status === 'fulfilled' ? billers.value : [];
  const gcs = giftCards.status === 'fulfilled' ? giftCards.value : [];

  const airtimeOps = ops.filter(op => !op.data && !op.bundle);
  const dataOps = ops.filter(op => op.data || op.bundle);

  // Group gift cards by brand
  const brands = new Map<string, number>();
  for (const gc of gcs) {
    brands.set(gc.brand.brandName, (brands.get(gc.brand.brandName) || 0) + 1);
  }

  // Group billers by type
  const billerTypes = new Map<string, number>();
  for (const b of bills) {
    billerTypes.set(b.type, (billerTypes.get(b.type) || 0) + 1);
  }

  return {
    countryCode: cc,
    airtime: {
      available: airtimeOps.length > 0,
      operators: airtimeOps.map(op => ({ id: op.operatorId, name: op.name })),
    },
    dataPlans: {
      available: dataOps.length > 0,
      operators: dataOps.map(op => ({ id: op.operatorId, name: op.name })),
    },
    bills: {
      available: bills.length > 0,
      total: bills.length,
      types: Object.fromEntries(billerTypes),
    },
    giftCards: {
      available: gcs.length > 0,
      totalProducts: gcs.length,
      brands: Array.from(brands.keys()),
    },
  };
}

/**
 * Get FX rate for a country (local currency per 1 USD).
 * Uses operator data to extract the rate — cached via normal Reloadly caching.
 */
export async function getFxRate(countryCode: string): Promise<{ rate: number; currencyCode: string } | null> {
  try {
    const operators = await getOperators(countryCode.toUpperCase());
    for (const op of operators) {
      if (op.fx?.rate && op.fx.rate > 0) {
        return { rate: op.fx.rate, currencyCode: op.fx.currencyCode };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Startup Pre-warming ───

/**
 * Pre-warm auth tokens on startup so first user request doesn't wait for auth.
 * Called once when the module loads — non-blocking, fire-and-forget.
 */
function prewarmTokens() {
  Promise.all([
    getToken('airtime').catch(() => {}),
    getToken('utilities').catch(() => {}),
    getToken('giftcards').catch(() => {}),
  ]).then(() => {
    console.log('[Reloadly] Auth tokens pre-warmed');
  });
}

// Pre-warm on module load
prewarmTokens();
