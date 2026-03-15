/**
 * Reloadly API - Airtime top-ups and utility bill payments
 *
 * Sandbox: Free, no real money. Use for demo.
 * Production: Pre-funded USD business wallet.
 *
 * Supports 150+ countries, 800+ operators.
 */

const isProduction = process.env.NODE_ENV === 'production';

const AIRTIME_BASE_URL = isProduction
  ? 'https://topups.reloadly.com'
  : 'https://topups-sandbox.reloadly.com';

const UTILITIES_BASE_URL = isProduction
  ? 'https://utilities.reloadly.com'
  : 'https://utilities-sandbox.reloadly.com';

const AUTH_URL = 'https://auth.reloadly.com/oauth/token';

const CLIENT_ID = process.env.RELOADLY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET || '';

// Token cache
let airtimeToken: { token: string; expiresAt: number } | null = null;
let utilitiesToken: { token: string; expiresAt: number } | null = null;

// ─── Auth ───

async function getToken(product: 'airtime' | 'utilities'): Promise<string> {
  const cached = product === 'airtime' ? airtimeToken : utilitiesToken;
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const audience = product === 'airtime' ? AIRTIME_BASE_URL : UTILITIES_BASE_URL;

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
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000, // refresh 1 min early
  };

  if (product === 'airtime') {
    airtimeToken = tokenData;
  } else {
    utilitiesToken = tokenData;
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
    customIdentifier: `jara-${Date.now()}`,
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
    referenceId: `jara-bill-${Date.now()}`,
  });
}
