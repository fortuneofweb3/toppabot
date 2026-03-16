/**
 * Reloadly API - Digital goods: Airtime, Data, Gift Cards, Utility Bills
 *
 * Sandbox: Free, no real money. Use for demo.
 * Production: Pre-funded USD business wallet.
 *
 * Covers 170+ countries, 800+ operators, 300+ gift card brands (14,000+ products).
 */

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

async function airtimeRequest<T>(method: 'GET' | 'POST', path: string, body?: any): Promise<T> {
  const token = await getToken('airtime');

  const response = await fetch(`${AIRTIME_BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/com.reloadly.topups-v1+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000), // 30 second timeout
  });

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
}

async function utilitiesRequest<T>(method: 'GET' | 'POST', path: string, body?: any): Promise<T> {
  const token = await getToken('utilities');

  const response = await fetch(`${UTILITIES_BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000), // 30 second timeout
  });

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
}

async function giftcardsRequest<T>(method: 'GET' | 'POST', path: string, body?: any): Promise<T> {
  const token = await getToken('giftcards');

  const response = await fetch(`${GIFTCARDS_BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/com.reloadly.giftcards-v1+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000), // 30 second timeout
  });

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
}

// ─── Types ───

export interface ReloadlyOperator {
  id: number;
  operatorId: number;
  name: string;
  bundle: boolean;
  data: boolean;
  denominationType: 'RANGE' | 'FIXED';
  senderCurrencyCode: string;
  destinationCurrencyCode: string;
  minAmount: number;
  maxAmount: number;
  localMinAmount: number;
  localMaxAmount: number;
  fixedAmounts: number[] | null;
  fixedAmountsDescriptions: Record<string, string> | null;
  localFixedAmounts: number[] | null;
  localFixedAmountsDescriptions: Record<string, string> | null;
  supportsLocalAmounts: boolean;
  commission: number;
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
  transactionDate: string;
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
  internationalTransactionFee: number;
}

export interface ReloadlyBillPaymentResponse {
  id: number;
  status: string;
  referenceId: string;
  code: string;
  message: string;
  submittedAt: string;
}

// ─── Airtime Functions ───

/**
 * Get mobile operators for a country
 */
export async function getOperators(countryCode: string) {
  return airtimeRequest<ReloadlyOperator[]>(
    'GET',
    `/operators/countries/${countryCode.toUpperCase()}`
  );
}

/**
 * Auto-detect operator from phone number
 */
export async function detectOperator(phone: string, countryCode: string) {
  return airtimeRequest<ReloadlyOperator>(
    'GET',
    `/operators/auto-detect/phone/${phone}/countries/${countryCode.toUpperCase()}`
  );
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
  // Auto-detect operator if not provided
  let operatorId = params.operatorId;
  if (!operatorId) {
    const operator = await detectOperator(params.phone, params.countryCode);
    operatorId = operator.operatorId;
  }

  return airtimeRequest<ReloadlyTopupResponse>('POST', '/topups', {
    operatorId,
    amount: params.amount,
    useLocalAmount: params.useLocalAmount ?? false,
    customIdentifier: `toppa-${Date.now()}`,
    recipientPhone: {
      countryCode: params.countryCode.toUpperCase(),
      number: params.phone,
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
  return airtimeRequest<ReloadlyTopupResponse>('POST', '/topups', {
    operatorId: params.operatorId,
    amount: params.amount,
    useLocalAmount: params.useLocalAmount ?? false,
    customIdentifier: `toppa-data-${Date.now()}`,
    recipientPhone: {
      countryCode: params.countryCode.toUpperCase(),
      number: params.phone,
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
  const query = new URLSearchParams({
    countryISOCode: params.countryCode.toUpperCase(),
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
  if (Array.isArray(response)) return response;
  if (response && 'content' in response) return response.content;
  return [];
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
    useLocalAmount: params.useLocalAmount ?? true,
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
  denominationType: 'FIXED' | 'RANGE';
  fixedRecipientDenominations: number[];
  fixedSenderDenominations: number[];
  minRecipientDenomination: number | null;
  maxRecipientDenomination: number | null;
  minSenderDenomination: number | null;
  maxSenderDenomination: number | null;
  brand: {
    brandId: number;
    brandName: string;
  };
  country: {
    isoName: string;
    name: string;
  };
  logoUrls: string[];
  redeemInstruction: {
    concise: string;
    verbose: string;
  };
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
  return giftcardsRequest<ReloadlyGiftCardProduct[]>(
    'GET',
    `/countries/${countryCode.toUpperCase()}/products`
  );
}

/**
 * Search gift card products by name
 */
export async function searchGiftCards(query: string, countryCode?: string) {
  let products: ReloadlyGiftCardProduct[];

  if (countryCode) {
    products = await getGiftCardProducts(countryCode);
  } else {
    // Global search — API may return paginated {content: [...]} or direct array
    const response = await giftcardsRequest<ReloadlyGiftCardProduct[] | { content: ReloadlyGiftCardProduct[] }>(
      'GET',
      '/products?size=200'
    );
    products = Array.isArray(response) ? response : (response?.content || []);
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
    `/orders/${transactionId}/cards`
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
  return airtimeRequest<ReloadlyCountry[]>('GET', '/countries');
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
  const path = countryCode
    ? `/promotions/country-codes/${countryCode.toUpperCase()}`
    : '/promotions?page=0&size=50';

  const response = await airtimeRequest<any>('GET', path);

  // Handle paginated or array response
  if (Array.isArray(response)) return response;
  if (response?.content) return response.content;
  return [];
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
