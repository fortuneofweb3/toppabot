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

const CLIENT_ID = process.env.RELOADLY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET || '';

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
  });

  if (!response.ok) {
    let errorMsg: string;
    try {
      const err = await response.json();
      errorMsg = (err as any).message || `Request failed: ${response.status}`;
    } catch {
      errorMsg = `Request failed: ${response.status}`;
    }
    throw new Error(errorMsg);
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
  });

  if (!response.ok) {
    let errorMsg: string;
    try {
      const err = await response.json();
      errorMsg = (err as any).message || `Request failed: ${response.status}`;
    } catch {
      errorMsg = `Request failed: ${response.status}`;
    }
    throw new Error(errorMsg);
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
  });

  if (!response.ok) {
    let errorMsg: string;
    try {
      const err = await response.json();
      errorMsg = (err as any).message || `Request failed: ${response.status}`;
    } catch {
      errorMsg = `Request failed: ${response.status}`;
    }
    throw new Error(errorMsg);
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
    size: '50',
  });
  if (params.type) {
    query.set('type', params.type);
  }

  return utilitiesRequest<ReloadlyBiller[]>('GET', `/billers?${query.toString()}`);
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
  const products = countryCode
    ? await getGiftCardProducts(countryCode)
    : await giftcardsRequest<ReloadlyGiftCardProduct[]>('GET', '/products?size=200');

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
