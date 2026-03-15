import crypto from 'crypto';

/**
 * Fonbnk Offramp API - cUSD → Local Currency via Celo
 *
 * Supports 15 countries across Africa, Latin America, and Asia:
 * NG (Nigeria), KE (Kenya), ZA (South Africa), GH (Ghana),
 * UG (Uganda), TZ (Tanzania), ZM (Zambia), BR (Brazil),
 * PH (Philippines), BJ (Benin), CG (Congo), CM (Cameroon),
 * GA (Gabon), SN (Senegal), CI (Ivory Coast)
 *
 * Flow:
 * 1. getCountries()  → see supported countries + offramp types
 * 2. getBestOffer()   → get exchange rate + required fields
 * 3. createOrder()    → create order with recipient details, get deposit address
 * 4. User sends cUSD to deposit address
 * 5. confirmOrder()   → confirm with tx hash
 * 6. Fonbnk sends local currency to recipient
 */

const FONBNK_PROD_URL = 'https://aten.fonbnk-services.com';
const FONBNK_SANDBOX_URL = 'https://sandbox-api.fonbnk.com';

const API_URL = process.env.NODE_ENV === 'production'
  ? FONBNK_PROD_URL
  : (process.env.FONBNK_API_URL || FONBNK_SANDBOX_URL);

const CLIENT_ID = process.env.FONBNK_CLIENT_ID || '';
const API_SECRET = process.env.FONBNK_API_SIGNATURE_SECRET || '';

// ─── Supported Countries ───

export const SUPPORTED_COUNTRIES: Record<string, {
  name: string;
  currency: string;
  types: string[];
}> = {
  NG: { name: 'Nigeria', currency: 'NGN', types: ['bank'] },
  KE: { name: 'Kenya', currency: 'KES', types: ['bank', 'mobile_money'] },
  ZA: { name: 'South Africa', currency: 'ZAR', types: ['bank'] },
  GH: { name: 'Ghana', currency: 'GHS', types: ['mobile_money'] },
  UG: { name: 'Uganda', currency: 'UGX', types: ['mobile_money'] },
  TZ: { name: 'Tanzania', currency: 'TZS', types: ['mobile_money'] },
  ZM: { name: 'Zambia', currency: 'ZMW', types: ['mobile_money'] },
  BR: { name: 'Brazil', currency: 'BRL', types: ['bank'] },
  PH: { name: 'Philippines', currency: 'PHP', types: ['bank'] },
  BJ: { name: 'Benin', currency: 'XOF', types: ['mobile_money'] },
  CM: { name: 'Cameroon', currency: 'XAF', types: ['mobile_money'] },
  SN: { name: 'Senegal', currency: 'XOF', types: ['mobile_money'] },
  CI: { name: 'Ivory Coast', currency: 'XOF', types: ['mobile_money'] },
  CG: { name: 'Republic of the Congo', currency: 'XAF', types: ['mobile_money'] },
  GA: { name: 'Gabon', currency: 'XAF', types: ['mobile_money'] },
};

// ─── HMAC Signature ───

function generateSignature(timestamp: string, path: string): string {
  const stringToSign = `${timestamp}:${path}`;
  const decodedSecret = Buffer.from(API_SECRET, 'base64');
  return crypto
    .createHmac('sha256', decodedSecret)
    .update(stringToSign)
    .digest('base64');
}

async function fonbnkRequest<T>(method: 'GET' | 'POST', path: string, body?: any): Promise<T> {
  const timestamp = Date.now().toString();
  const signature = generateSignature(timestamp, path);

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': CLIENT_ID,
      'x-timestamp': timestamp,
      'x-signature': signature,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let errorMsg: string;
    try {
      const err = await response.json();
      errorMsg = (err as any).message || `Request failed with status ${response.status}`;
    } catch {
      errorMsg = `Request failed with status ${response.status}`;
    }
    throw new Error(errorMsg);
  }

  return response.json() as Promise<T>;
}

// ─── Types ───

export interface FonbnkOffer {
  _id: string;
  countryIsoCode: string;
  currencyIsoCode: string;
  exchangeRate: number;
  cryptoExchangeRate?: number;
  paymentChannel?: string;
  requiredFields: Record<string, {
    key: string;
    type: string;
    label: string;
    required: boolean;
    options?: { value: string; label: string }[];
    defaultValue?: string;
  }>;
  type: string;
}

export interface FonbnkCashout {
  localCurrencyAmount: number;
  usdAmount: number;
  cryptoAmount: number;
  feeAmountUsd: number;
  feeAmountLocalCurrency: number;
  feeAmountCrypto: number;
}

export interface FonbnkBestOfferResponse {
  quoteId: string;
  offer: FonbnkOffer;
  cashout: FonbnkCashout;
}

export interface FonbnkOrder {
  _id: string;
  offerId: string;
  network: string;
  asset: string;
  exchangeRate: number;
  amountUsd: number;
  amountFiat: number;
  fromAddress: string;
  toAddress: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  hash: string;
  requiredFields: Record<string, string>;
  countryIsoCode: string;
  currencyIsoCode: string;
}

// ─── API Functions ───

/**
 * Get supported countries and their offramp types (live from Fonbnk)
 */
export async function getCountries() {
  return fonbnkRequest<any[]>('GET', '/api/offramp/countries');
}

/**
 * Get best offer for cUSD conversion to local currency
 * Supports any country Fonbnk operates in
 */
export async function getBestOffer(params?: {
  amount?: number;
  country?: string;
  type?: string;
}) {
  const country = params?.country || 'NG';
  const type = params?.type || (SUPPORTED_COUNTRIES[country]?.types[0] || 'bank');
  const amount = params?.amount || 10;

  return fonbnkRequest<FonbnkBestOfferResponse>(
    'GET',
    `/api/offramp/best-offer?type=${type}&country=${country}&network=CELO&asset=CUSD&currency=usd&amount=${amount}`
  );
}

/**
 * Create an offramp order
 * Returns a deposit address where user sends cUSD
 */
export async function createOrder(params: {
  offerId: string;
  amount: number;
  senderAddress: string;
  requiredFields: Record<string, string>;
}) {
  return fonbnkRequest<FonbnkOrder>('POST', '/api/offramp/create-order', {
    offerId: params.offerId,
    network: 'CELO',
    asset: 'CUSD',
    amount: params.amount,
    address: params.senderAddress,
    requiredFields: params.requiredFields,
  });
}

/**
 * Confirm order after user sends cUSD
 */
export async function confirmOrder(params: {
  orderId: string;
  txHash: string;
}) {
  return fonbnkRequest<FonbnkOrder>('POST', '/api/offramp/confirm-order', {
    orderId: params.orderId,
    hash: params.txHash,
  });
}

/**
 * Get order status by ID
 */
export async function getOrder(orderId: string) {
  return fonbnkRequest<FonbnkOrder>('GET', `/api/offramp/order/${orderId}`);
}

// ─── Convenience Functions ───

/**
 * Get current exchange rate for any supported country
 */
export async function getRate(country?: string) {
  try {
    const response = await getBestOffer({ country });
    const countryInfo = SUPPORTED_COUNTRIES[response.offer.countryIsoCode];
    return {
      rate: response.offer.exchangeRate,
      currency: response.offer.currencyIsoCode,
      country: response.offer.countryIsoCode,
      countryName: countryInfo?.name,
      source: 'fonbnk',
      offerId: response.offer._id,
      quoteId: response.quoteId,
    };
  } catch (error) {
    return {
      rate: 0,
      currency: SUPPORTED_COUNTRIES[country || 'NG']?.currency || 'NGN',
      country: country || 'NG',
      source: 'error',
      offerId: null,
      quoteId: null,
    };
  }
}

// Backward-compatible alias
export const getCUSDtoNGNRate = () => getRate('NG');

/**
 * Full offramp flow: get offer → create order → return deposit address
 */
export async function initiateOfframp(params: {
  amount: number;
  senderAddress: string;
  bankDetails: Record<string, string>;
  country?: string;
  type?: string;
}) {
  try {
    const country = params.country || 'NG';
    const response = await getBestOffer({
      amount: params.amount,
      country,
      type: params.type,
    });

    const order = await createOrder({
      offerId: response.offer._id,
      amount: params.amount,
      senderAddress: params.senderAddress,
      requiredFields: params.bankDetails,
    });

    const countryInfo = SUPPORTED_COUNTRIES[country];

    return {
      success: true,
      orderId: order._id,
      quoteId: response.quoteId,
      depositAddress: order.toAddress,
      exchangeRate: response.offer.exchangeRate,
      amountUsd: response.cashout.usdAmount,
      amountLocal: response.cashout.localCurrencyAmount,
      localCurrency: countryInfo?.currency || response.offer.currencyIsoCode,
      country,
      countryName: countryInfo?.name,
      fee: response.cashout.feeAmountUsd,
      expiresAt: order.expiresAt,
      status: order.status,
    };
  } catch (error) {
    throw new Error(`Offramp failed: ${error.message}`);
  }
}

/**
 * Generate widget URL for off-ramp (browser-based alternative)
 */
export function generateOfframpWidgetUrl(params: {
  amount: number;
  network?: string;
  asset?: string;
  countryIsoCode?: string;
}) {
  const baseUrl = process.env.NODE_ENV === 'production'
    ? 'https://pay.fonbnk.com/offramp'
    : 'https://sandbox-pay.fonbnk.com/offramp';

  const source = process.env.FONBNK_SOURCE || '';
  const urlSecret = process.env.FONBNK_URL_SIGNATURE_SECRET || '';

  const timestamp = Date.now().toString();
  const stringToSign = `${timestamp}:${source}`;
  const decodedSecret = Buffer.from(urlSecret, 'base64');
  const signature = crypto
    .createHmac('sha256', decodedSecret)
    .update(stringToSign)
    .digest('base64');

  const queryParams = new URLSearchParams({
    source,
    signature,
    timestamp,
    network: params.network || 'CELO',
    asset: params.asset || 'CUSD',
    amount: params.amount.toString(),
    currency: 'local',
    countryIsoCode: params.countryIsoCode || 'NG',
  });

  return `${baseUrl}?${queryParams.toString()}`;
}
