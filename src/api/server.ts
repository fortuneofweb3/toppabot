import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { createX402PaymentRequest, verifyX402Payment, getX402Info, calculateTotalPayment } from '../blockchain/x402';
import { reservePaymentHash, releasePaymentHash } from '../blockchain/replay-guard';
import {
  sendAirtime, getOperators,
  getDataOperators, sendData,
  getBillers, payBill as payReloadlyBill,
  getGiftCardProducts, searchGiftCards, buyGiftCard, getGiftCardRedeemCode,
  getCountries, getCountryServices, getAccountBalance, getPromotions,
  getAirtimeTransaction, getBillTransaction,
  getFxRate,
  ReloadlyError,
} from '../apis/reloadly';
import { recordTransaction, getAgentReputation, getAgentDetails, getAgentRegistrationFile } from '../blockchain/erc8004';
import { createReceipt, updateReceipt, getReceiptByTxHash, getReceiptsByPayer, getFailedReceipts, getReceiptStats } from '../blockchain/service-receipts';
import { PAYMENT_TOKEN_SYMBOL } from '../blockchain/x402';
import { handleMcpRequest } from '../mcp/server';
import { generateAgentCard } from '../a2a/agent-card';
import { handleA2ARequest } from '../a2a/handler';
import { CELO_CAIP2 } from '../shared/constants';
import { refundPayer } from '../shared/refund';

export const app = express();
const isProduction = process.env.NODE_ENV === 'production';

// Trust Railway proxy for correct IP detection (rate limiting, logging)
// Railway uses 1 proxy hop - trust only the immediate proxy, not any upstream
app.set('trust proxy', 1);

// ─────────────────────────────────────────────────
// Security Middleware
// ─────────────────────────────────────────────────

// Request body size limit (prevent memory exhaustion)
app.use(express.json({ limit: '1mb' }));

// Security headers (XSS, clickjacking, MIME sniffing protection)
app.use(helmet({
  contentSecurityPolicy: false, // Allow SVG embedding for /agent-image.svg
  crossOriginEmbedderPolicy: false,
}));

// Request logging (production uses combined format, dev uses dev format)
app.use(morgan(isProduction ? 'combined' : 'dev'));

// CORS: Public API routes (MCP, A2A, x402 paid endpoints) must be accessible from any origin.
// Browser-only routes (if any future admin UI) can be restricted via ALLOWED_ORIGINS.
app.use(cors({
  origin: true, // Reflect request origin (equivalent to '*' but works with credentials)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'X-PAYMENT', 'PAYMENT-SIGNATURE', 'X-402-PAYMENT', 'Mcp-Session-Id', 'X-Admin-Key'],
  exposedHeaders: ['PAYMENT-RESPONSE', 'X-Payment-Required'],
}));

// Rate limiting (prevent DDoS and brute force)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 100 : 1000, // Limit each IP to 100 requests per 15min in prod
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Stricter rate limit for paid endpoints (prevent payment spam)
const paymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: isProduction ? 20 : 100, // 20 paid requests per 5min in prod
  message: 'Too many payment requests, please slow down.',
});

// Per-payer rate limiting (MongoDB-backed, survives restarts)
import { getDb } from '../wallet/mongo-store';

const PAYER_RATE_LIMIT = 10; // 10 requests per 5 min per wallet
const PAYER_RATE_WINDOW_SEC = 5 * 60; // 5 minutes in seconds

let _payerRateCollection: any = null;
let _payerRateIndexCreated = false;

async function getPayerRateCollection() {
  if (_payerRateCollection && _payerRateIndexCreated) return _payerRateCollection;
  const db = await getDb();
  _payerRateCollection = db.collection('payer_rate_limits');
  if (!_payerRateIndexCreated) {
    await _payerRateCollection.createIndex({ payer: 1 }, { unique: true });
    // TTL index — auto-cleanup expired entries
    await _payerRateCollection.createIndex({ resetAt: 1 }, { expireAfterSeconds: 0 });
    _payerRateIndexCreated = true;
  }
  return _payerRateCollection;
}

async function checkPayerRate(payer: string): Promise<boolean> {
  try {
    const col = await getPayerRateCollection();
    const now = new Date();
    const resetAt = new Date(now.getTime() + PAYER_RATE_WINDOW_SEC * 1000);

    // Atomic: increment count if window active, or reset if expired
    const result = await col.findOneAndUpdate(
      { payer },
      [
        {
          $set: {
            count: {
              $cond: {
                if: { $gt: ['$resetAt', now] },
                then: { $add: ['$count', 1] },
                else: 1,
              },
            },
            resetAt: {
              $cond: {
                if: { $gt: ['$resetAt', now] },
                then: '$resetAt',
                else: resetAt,
              },
            },
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );

    const doc = result?.value || result;
    return (doc?.count || 0) <= PAYER_RATE_LIMIT;
  } catch (err: any) {
    console.error('[PayerRate] Error checking rate:', err.message);
    return true; // Fail open — don't block on rate limit errors
  }
}

// HTTPS enforcement in production
if (isProduction) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      res.redirect(`https://${req.header('host')}${req.url}`);
    } else {
      next();
    }
  });
}

// Serve static files (logo, etc.)
app.use('/public', express.static(path.join(__dirname, '../../public')));

/**
 * Format error response — includes Reloadly error code when available
 * In production, avoid leaking internal error details
 */
/**
 * Determine HTTP status code from error type
 * - ReloadlyError: use its httpStatus
 * - Validation errors (Invalid/Missing): 400
 * - Everything else: 500
 */
/**
 * Map Reloadly status to our receipt status.
 * SUCCESSFUL → success, REFUNDED/FAILED → failed, everything else (PENDING etc.) → pending
 */
function reloadlyReceiptStatus(reloadlyStatus: string): 'success' | 'failed' | 'pending' {
  if (reloadlyStatus === 'SUCCESSFUL') return 'success';
  if (reloadlyStatus === 'REFUNDED' || reloadlyStatus === 'FAILED') return 'failed';
  return 'pending'; // PENDING, PROCESSING, etc.
}

function errorStatus(error: any): number {
  if (error instanceof ReloadlyError) return error.httpStatus;
  const msg = error?.message || '';
  if (msg.startsWith('Invalid') || msg.startsWith('Missing')) return 400;
  return 500;
}

function errorResponse(error: any): { error: string; code?: string } {
  // Log full error server-side for debugging (never sent to client)
  if (isProduction) {
    console.error('[ERROR]', {
      message: error.message,
      code: error.code,
      // Don't log full stack in production (may contain file paths)
      type: error.name,
    });
  } else {
    // Dev mode: log full stack for debugging
    console.error('[ERROR]', error);
  }

  // Return safe error to client
  if (error instanceof ReloadlyError) {
    return { error: error.message, code: error.code };
  }

  // In production, return generic message for unknown errors (prevent info leakage)
  if (isProduction && !error.message?.startsWith('Missing') && !error.message?.startsWith('Invalid')) {
    return { error: 'An error occurred processing your request' };
  }

  // Dev mode: return full error for debugging
  return { error: error.message || 'Unknown error' };
}

/**
 * Shared catch handler for x402 paid endpoints.
 * Marks receipt as failed, auto-refunds if service didn't succeed, sends error response.
 */
async function handleX402Error(
  error: unknown, req: X402Request, res: Response,
  receiptId: string, serviceSucceeded: boolean,
): Promise<void> {
  if (receiptId) {
    await updateReceipt(receiptId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
  // Auto-refund ONLY if the Reloadly service call itself failed.
  // If service succeeded but bookkeeping (updateReceipt/recordTransaction) threw, do NOT refund.
  if (!serviceSucceeded && req.x402?.payer && req.x402.breakdown) {
    const refundTx = await refundPayer(req.x402.payer, req.x402.breakdown.total, 'x402_api', req.x402.txHash);
    if (refundTx && receiptId) await updateReceipt(receiptId, { refundTxHash: refundTx });
  }
  res.status(errorStatus(error)).json(errorResponse(error));
}

// Sanitization functions imported from shared module
import { sanitizeCountryCode, sanitizePhone } from '../shared/sanitize';

/**
 * Parse and validate integer (prevent NaN propagation)
 */
function parseIntSafe(value: string | string[], fieldName: string): number {
  const input = Array.isArray(value) ? value[0] : value;
  if (!input) {
    throw new Error(`Invalid ${fieldName}: must be a positive number`);
  }
  const parsed = parseInt(input);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid ${fieldName}: must be a positive number`);
  }
  return parsed;
}

/**
 * Parse and validate float (prevent NaN propagation)
 */
function parseFloatSafe(value: any, fieldName: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: must be a number`);
  }
  const str = String(value).trim();
  // Allow digits with optional decimal, max 6 decimal places (USDC precision)
  if (!/^\d+(\.\d{1,6})?$/.test(str)) {
    throw new Error(`Invalid ${fieldName}: must be a valid positive number (max 6 decimal places)`);
  }
  const parsed = parseFloat(str);
  if (!isFinite(parsed) || parsed <= 0 || parsed > 10000) {
    throw new Error(`Invalid ${fieldName}: must be a positive number (max 10,000)`);
  }
  return parsed;
}

/**
 * Validate a value is a positive integer (for IDs like operatorId, billerId, productId).
 * Accepts both number and numeric string inputs. Returns the validated integer.
 */
function requirePositiveInt(value: any, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : parseInt(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: must be a positive integer`);
  }
  return parsed;
}

/**
 * Sanitize account number — alphanumeric, hyphens, and spaces only. Max 50 chars.
 * Prevents injection via account number fields sent to third-party APIs.
 */
function sanitizeAccountNumber(value: any, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${fieldName}: must be a non-empty string`);
  }
  const trimmed = value.trim();
  // Validate BEFORE truncating — reject the full input if it has bad chars
  if (!/^[a-zA-Z0-9\- ]+$/.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}: contains invalid characters (alphanumeric, hyphens, and spaces only)`);
  }
  if (trimmed.length > 50) {
    throw new Error(`Invalid ${fieldName}: too long (max 50 characters)`);
  }
  return trimmed;
}

/**
 * Basic email format validation (RFC 5322 simplified).
 * Rejects obvious garbage before sending to Reloadly.
 */
function validateEmail(value: any, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: must be a string`);
  }
  const trimmed = value.trim().toLowerCase();
  // Stricter email validation: single @, no consecutive dots, safe characters only
  if (
    trimmed.length > 254 ||
    trimmed.length < 5 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)
  ) {
    throw new Error(`Invalid ${fieldName}: must be a valid email address`);
  }
  return trimmed;
}

// Shared balance cache — single instance across API and MCP
import { getCachedReloadlyBalance as getReloadlyBalance } from '../shared/balance-cache';

/**
 * Cap a max amount based on available Reloadly balance
 */
function capMaxAmount(max: number | null, balance: number): number {
  if (max === null || max === undefined) return balance;
  return Math.min(max, balance);
}

// ─────────────────────────────────────────────────
// x402 Payment Middleware
// Gates paid endpoints behind HTTP 402 Payment Required
// ─────────────────────────────────────────────────

// CAIP-2 network identifiers imported from shared/constants

interface X402Request extends Request {
  x402?: {
    verified: boolean;
    txHash: string;
    payer: string;
    totalPaid: string;
    breakdown: { total: number; productAmount: number; serviceFee: number };
  };
}

/**
 * Generate x402 PAYMENT-RESPONSE header (Base64-encoded SettleResponse).
 * Per spec, returned after successful service delivery.
 */
function encodePaymentResponse(x402: NonNullable<X402Request['x402']>): string {
  const settleResponse = {
    success: true,
    transaction: x402.txHash,
    network: CELO_CAIP2,
    payer: x402.payer,
  };
  return Buffer.from(JSON.stringify(settleResponse)).toString('base64');
}

/**
 * Extract product amount from request body based on endpoint
 * Returns the USD amount the user wants to spend on the product
 */
function getProductAmount(req: Request): number | undefined {
  const body = req.body;
  if (!body) return undefined;

  const amount = parseFloat(body.amount);
  if (!isNaN(amount) && isFinite(amount) && amount > 0 && amount <= 10000) return amount;

  return undefined;
}

/**
 * x402 middleware — gates paid endpoints behind HTTP 402 Payment Required
 * Fee: product_amount * 1.5% (flat)
 */
async function x402Middleware(req: X402Request, res: Response, next: NextFunction) {
  const paymentHeader = (
    req.headers['x-payment'] ||
    req.headers['payment-signature'] ||
    req.headers['x-402-payment']
  ) as string;

  // Calculate dynamic fee from request body
  const productAmount = getProductAmount(req);
  const { total, serviceFee } = calculateTotalPayment(productAmount);

  if (!paymentHeader) {
    const paymentRequest = await createX402PaymentRequest({
      service: `${req.method} ${req.path}`,
      description: `Toppa API: ${req.method} ${req.path}`,
      productAmount,
    });

    res.set('X-Payment-Required', paymentRequest.headers['X-Payment-Required']);
    res.status(402).json(paymentRequest.body);
    return;
  }

  try {
    // Reserve hash atomically in MongoDB — prevents replay attacks
    const isReserved = await reservePaymentHash(paymentHeader, 'x402_api');
    if (!isReserved) {
      res.status(402).json({
        error: 'Payment already used',
        message: 'This transaction hash has already been used for a previous request. Submit a new payment.',
      });
      return;
    }

    const verification = await verifyX402Payment(paymentHeader, total);

    if (!verification.verified) {
      // Release the hash so it can potentially be retried (e.g. wrong amount)
      await releasePaymentHash(paymentHeader);
      res.status(402).json({
        error: 'Payment verification failed',
        message: verification.error || 'The provided payment could not be verified',
        required: { total, productAmount: productAmount || 0, serviceFee },
      });
      return;
    }

    // Per-payer rate limit check (after verification, before service execution)
    const payer = verification.payer || 'unknown';
    if (!(await checkPayerRate(payer))) {
      await releasePaymentHash(paymentHeader);
      res.status(429).json({
        error: 'Too many requests from this wallet. Please wait before making another request.',
      });
      return;
    }

    req.x402 = {
      verified: true,
      txHash: verification.txHash || paymentHeader,
      payer,
      totalPaid: verification.amount || total.toString(),
      breakdown: { total, productAmount: productAmount || 0, serviceFee },
    };

    next();
  } catch (error: any) {
    // Release on unexpected error so hash isn't permanently blocked
    await releasePaymentHash(paymentHeader).catch(() => {});
    console.error('[x402 Middleware Error]', error.message);
    res.status(402).json({
      error: 'Payment verification failed. Please check your payment and try again.',
    });
  }
}

// ─────────────────────────────────────────────────
// Public Routes (no payment required)
// ─────────────────────────────────────────────────

// Health check / agent info
app.get('/', (_req: Request, res: Response) => {
  const x402Info = getX402Info();
  res.json({
    agent: 'Toppa',
    version: '2.0.0',
    description: 'AI agent for digital goods and utility payments across 170+ countries on Celo',
    chain: x402Info.chain,
    protocols: {
      x402: {
        spec: x402Info.spec,
        fee: x402Info.fee,
        feeFormula: `product_amount * 1.015 (product + 1.5% fee)`,
        asset: x402Info.asset,
        payTo: x402Info.payTo,
        examples: {
          '$5_airtime': `${calculateTotalPayment(5).total} ${x402Info.currency}`,
          '$25_gift_card': `${calculateTotalPayment(25).total} ${x402Info.currency}`,
          '$100_bill': `${calculateTotalPayment(100).total} ${x402Info.currency}`,
        },
      },
      erc8004: {
        spec: 'https://eips.ethereum.org/EIPS/eip-8004',
        description: 'On-chain agent identity and reputation',
      },
      mcp: {
        spec: 'https://modelcontextprotocol.io',
        endpoint: '/mcp',
        transport: 'Streamable HTTP',
        tools: 13,
      },
      a2a: {
        spec: 'https://a2a-protocol.org',
        agentCard: '/.well-known/agent.json',
        endpoint: '/a2a',
        methods: ['message/send', 'tasks/get', 'tasks/cancel'],
      },
      selfProtocol: {
        spec: 'https://docs.self.xyz',
        description: 'ZK proof of humanity verification',
      },
    },
    services: [
      'airtime (mobile top-ups across 170+ countries)',
      'data_plans (mobile data bundles across 170+ countries)',
      'bills (electricity, water, TV, internet payments)',
      'gift_cards (300+ brands: Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, Apple, Google Play, prepaid Visa/Mastercard)',
    ],
    docs: {
      howToUse: `1) POST without payment to get 402 + exact amount needed. 2) Send ${x402Info.currency} to payTo address. 3) Retry with tx hash in X-PAYMENT header.`,
      pricing: 'Fee = product_amount * 1.5%. The 402 response includes the exact total.',
      example: 'curl -X POST https://api.toppa.cc/send-airtime -H "Content-Type: application/json" -d \'{"phone":"08147658721","countryCode":"NG","amount":5}\'',
    },
  });
});

// Health check endpoint (for monitoring, k8s/docker liveness probes)
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '2.0.0',
  });
});

// ERC-8004 Domain Verification — proves ownership of this domain
// Spec: https://eips.ethereum.org/EIPS/eip-8004#endpoint-domain-verification
app.get('/.well-known/agent-registration.json', (_req: Request, res: Response) => {
  const agentId = parseInt(process.env.AGENT_ID || '1870');
  const chainId = process.env.NODE_ENV === 'production' ? 42220 : 44787;
  const registryAddress = process.env.ERC8004_REGISTRY_ADDRESS || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

  res.set('Access-Control-Allow-Origin', '*');
  res.json({
    registrations: [
      {
        agentId,
        agentRegistry: `eip155:${chainId}:${registryAddress}`,
      },
    ],
  });
});

// Agent image (PNG) for ERC-8004 registration / explorers
app.get('/agent-image.png', (_req: Request, res: Response) => {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(process.cwd(), 'public/toppa-project-pfp.png'));
});

// Legacy SVG route
app.get('/agent-image.svg', (_req: Request, res: Response) => {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(process.cwd(), 'public/agent-image.svg'));
});

// ─────────────────────────────────────────────────
// Base route info (no params) — so scanners don't get 404
// ─────────────────────────────────────────────────
app.get('/operators', (_req: Request, res: Response) => {
  res.json({ endpoint: 'GET /operators/:country', description: 'List mobile operators for a country', example: '/operators/NG', params: { country: 'ISO country code (e.g. NG, KE, GH, US)' } });
});
app.get('/data-plans', (_req: Request, res: Response) => {
  res.json({ endpoint: 'GET /data-plans/:country', description: 'List data plan operators for a country', example: '/data-plans/NG', params: { country: 'ISO country code' } });
});
app.get('/billers', (_req: Request, res: Response) => {
  res.json({ endpoint: 'GET /billers/:country', description: 'List utility billers for a country', example: '/billers/NG', params: { country: 'ISO country code' } });
});
app.get('/gift-cards', (_req: Request, res: Response) => {
  res.json({ endpoint: 'GET /gift-cards/:country', description: 'List gift card brands for a country', example: '/gift-cards/US', alternateEndpoint: 'GET /gift-cards/search?q=Steam' });
});
app.get('/transaction', (_req: Request, res: Response) => {
  res.json({ endpoint: 'GET /transaction/:type/:id', description: 'Check transaction status', example: '/transaction/airtime/12345', params: { type: 'airtime | data | bill', id: 'Transaction ID from the service provider' } });
});

// Get mobile operators for a country (for airtime)
app.get('/operators/:country', async (req: Request, res: Response) => {
  try {
    const countryCode = sanitizeCountryCode(req.params.country);
    const operators = await getOperators(countryCode);
    const balance = await getReloadlyBalance();

    // Cap max amounts based on available balance
    const cappedOperators = operators.map(op => ({
      ...op,
      maxAmount: capMaxAmount(op.maxAmount, balance),
    }));

    res.json({
      country: countryCode,
      operators: cappedOperators,
      total: cappedOperators.length,
      accountBalance: balance,
    });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Get data plan operators for a country
app.get('/data-plans/:country', async (req: Request, res: Response) => {
  try {
    const countryCode = sanitizeCountryCode(req.params.country);
    const operators = await getDataOperators(countryCode);
    const balance = await getReloadlyBalance();

    res.json({
      country: countryCode,
      operators: operators.map(op => ({
        operatorId: op.operatorId,
        name: op.name,
        logoUrl: op.logoUrls?.[0] || null,
        isData: op.data,
        isBundle: op.bundle,
        denominationType: op.denominationType,
        fixedAmounts: op.fixedAmounts || [],
        fixedAmountsDescriptions: op.fixedAmountsDescriptions || {},
        localFixedAmounts: op.localFixedAmounts || [],
        localFixedAmountsDescriptions: op.localFixedAmountsDescriptions || {},
        minAmount: op.minAmount,
        maxAmount: capMaxAmount(op.maxAmount, balance),
        senderCurrency: op.senderCurrencyCode,
        localCurrency: op.destinationCurrencyCode,
        fxRate: op.fx?.rate || null,
      })),
      total: operators.length,
      accountBalance: balance,
    });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Get utility billers for a country
app.get('/billers/:country', async (req: Request, res: Response) => {
  try {
    const countryCode = sanitizeCountryCode(req.params.country);
    const type = req.query.type as string | undefined;
    const billers = await getBillers({
      countryCode,
      type: type as any,
    });
    res.json({ country: countryCode, billers, total: billers.length });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Search gift cards by brand name (MUST be before :country route)
app.get('/gift-cards/search', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    const countryCode = req.query.country as string | undefined;

    if (!query) {
      res.status(400).json({ error: 'Missing query parameter: q' });
      return;
    }

    const results = await searchGiftCards(query, countryCode);
    const balance = await getReloadlyBalance();

    res.json({
      query,
      results: results.slice(0, 20).map(p => ({
        productId: p.productId,
        name: p.productName,
        brand: p.brand.brandName,
        country: p.country.isoName,
        currency: p.recipientCurrencyCode,
        denominationType: p.denominationType,
        fixedDenominations: p.fixedRecipientDenominations?.slice(0, 5).filter(d => d <= balance),
        minAmount: p.minRecipientDenomination,
        maxAmount: capMaxAmount(p.maxRecipientDenomination, balance),
      })),
      total: results.length,
      accountBalance: balance,
    });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Get gift card brands for a country
app.get('/gift-cards/:country', async (req: Request, res: Response) => {
  try {
    const countryCode = sanitizeCountryCode(req.params.country);
    const products = await getGiftCardProducts(countryCode);
    const balance = await getReloadlyBalance();
    const brands = new Map<string, { brandName: string; products: number; minPrice: number; maxPrice: number; currency: string }>();

    for (const p of products) {
      const existing = brands.get(p.brand.brandName);
      const min = p.minSenderDenomination || p.fixedSenderDenominations?.[0] || 0;
      const max = p.maxSenderDenomination || p.fixedSenderDenominations?.slice(-1)[0] || 0;
      if (existing) {
        existing.products++;
        existing.minPrice = Math.min(existing.minPrice, min);
        existing.maxPrice = Math.max(existing.maxPrice, max);
      } else {
        brands.set(p.brand.brandName, { brandName: p.brand.brandName, products: 1, minPrice: min, maxPrice: max, currency: p.senderCurrencyCode });
      }
    }

    // Cap all max prices based on balance
    const cappedBrands = Array.from(brands.values()).map(b => ({
      ...b,
      maxPrice: capMaxAmount(b.maxPrice, balance),
    }));

    res.json({
      country: countryCode,
      totalProducts: products.length,
      brands: cappedBrands,
      accountBalance: balance,
    });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Get all supported countries
app.get('/countries', async (_req: Request, res: Response) => {
  try {
    const countries = await getCountries();
    res.json({
      total: countries.length,
      countries: countries.map(c => ({
        code: c.isoName,
        name: c.name,
        currency: c.currencyCode,
        callingCodes: c.callingCodes,
        flag: c.flag,
      })),
    });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Get full service availability for a country (airtime, data, bills, gift cards)
app.get('/countries/:code/services', async (req: Request, res: Response) => {
  try {
    const countryCode = sanitizeCountryCode(req.params.code);
    const services = await getCountryServices(countryCode);
    res.json(services);
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Get active promotions (operator bonuses/deals)
app.get('/promotions', async (_req: Request, res: Response) => {
  try {
    const promotions = await getPromotions();
    res.json({
      promotions: promotions.map((p: any) => ({
        id: p.promotionId || p.id,
        operatorId: p.operatorId,
        title: p.title || p.title2,
        startDate: p.startDate,
        endDate: p.endDate,
      })),
      total: promotions.length,
    });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

app.get('/promotions/:country', async (req: Request, res: Response) => {
  try {
    const countryCode = sanitizeCountryCode(req.params.country);
    const promotions = await getPromotions(countryCode);
    res.json({
      country: countryCode,
      promotions: promotions.map((p: any) => ({
        id: p.promotionId || p.id,
        operatorId: p.operatorId,
        title: p.title || p.title2,
        description: p.description,
        startDate: p.startDate,
        endDate: p.endDate,
      })),
      total: promotions.length,
    });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Check transaction status
app.get('/transaction/:type/:id', async (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    const txId = parseIntSafe(id, 'transaction ID');

    let result: any;
    if (type === 'airtime' || type === 'data') {
      result = await getAirtimeTransaction(txId);
    } else if (type === 'bill') {
      result = await getBillTransaction(txId);
    } else {
      res.status(400).json({ error: 'Invalid type. Use: airtime, data, or bill' });
      return;
    }

    res.json({
      transactionId: txId,
      type,
      status: result.status,
      operatorName: result.operatorName || result.billerName,
      amount: result.requestedAmount || result.amount,
      currency: result.requestedAmountCurrencyCode || result.currencyCode,
      date: result.transactionDate || result.submittedAt,
    });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Currency conversion using Reloadly FX rates
app.get('/convert', async (req: Request, res: Response) => {
  try {
    const { amount, from, country } = req.query;

    if (!amount || !from || !country) {
      res.status(400).json({
        error: 'Missing required query parameters',
        required: ['amount', 'from', 'country'],
        description: 'from=USD converts USD→local, from=LOCAL converts local→USD',
        example: '/convert?amount=10&from=USD&country=NG',
      });
      return;
    }

    const parsedAmount = parseFloat(amount as string);
    if (isNaN(parsedAmount) || !isFinite(parsedAmount) || parsedAmount <= 0) {
      res.status(400).json({ error: 'Invalid amount: must be a positive number' });
      return;
    }

    const countryCode = sanitizeCountryCode(country as string);
    const fxData = await getFxRate(countryCode);
    if (!fxData) {
      res.status(404).json({ error: `No FX rate available for country ${countryCode}` });
      return;
    }

    const { rate, currencyCode } = fxData;
    const direction = (from as string).toUpperCase();

    if (direction === 'USD') {
      const localAmount = Math.round(parsedAmount * rate * 100) / 100;
      res.json({
        from: { amount: parsedAmount, currency: 'USD' },
        to: { amount: localAmount, currency: currencyCode },
        fxRate: rate,
        country: countryCode,
      });
    } else {
      const usdAmount = Math.round((parsedAmount / rate) * 100) / 100;
      res.json({
        from: { amount: parsedAmount, currency: currencyCode },
        to: { amount: usdAmount, currency: 'USD' },
        fxRate: rate,
        country: countryCode,
      });
    }
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Agent identity (ERC-8004 on-chain details + registration file)
app.get('/identity', async (_req: Request, res: Response) => {
  try {
    const details = await getAgentDetails();
    const registrationFile = getAgentRegistrationFile();
    res.json({ agent: 'Toppa', onChain: details, registrationFile });
  } catch (error: any) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// Agent reputation (public - shows trust score)
app.get('/reputation', async (_req: Request, res: Response) => {
  try {
    const reputation = await getAgentReputation();
    res.json({
      agent: 'Toppa',
      ...reputation,
    });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

// ─────────────────────────────────────────────────
// MCP & A2A Protocol Routes
// ─────────────────────────────────────────────────

// MCP Streamable HTTP endpoint (13 tools for LLM/agent tool-use)
// The SDK rejects requests missing "Accept: text/event-stream" — inject it so
// scanners and basic health checks don't get a 406.
app.post('/mcp', paymentLimiter, (req: Request, res: Response, next: NextFunction) => {
  const accept = req.headers.accept || '';
  if (!accept.includes('text/event-stream')) {
    req.headers.accept = 'application/json, text/event-stream';
  }
  next();
}, async (req: Request, res: Response) => {
  try {
    await handleMcpRequest(req, res);
  } catch (error: any) {
    console.error('[MCP Error]', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP request failed' });
    }
  }
});

// MCP info for GET requests (scanners, browsers)
app.get('/mcp', (_req: Request, res: Response) => {
  res.json({
    protocol: 'MCP',
    transport: 'Streamable HTTP',
    version: '2025-03-26',
    tools: 13,
    toolNames: [
      'get_operators', 'get_data_plans', 'get_billers',
      'search_gift_cards', 'get_gift_cards', 'get_gift_card_code',
      'check_country', 'get_promotions', 'convert_currency',
      'send_airtime', 'send_data', 'pay_bill', 'buy_gift_card',
    ],
    endpoint: 'POST /mcp',
    description: 'Model Context Protocol endpoint — send JSON-RPC POST requests with Accept: application/json, text/event-stream',
  });
});

// A2A Agent Card discovery (Google Agent-to-Agent protocol)
app.get('/.well-known/agent.json', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(generateAgentCard());
});

// A2A discovery for GET requests — return full Agent Card so scanners/testers find skills
app.get('/a2a', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(generateAgentCard());
});

// A2A JSON-RPC 2.0 endpoint for task-based agent communication
app.post('/a2a', async (req: Request, res: Response) => {
  try {
    await handleA2ARequest(req, res);
  } catch (error: any) {
    console.error('[A2A Error]', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
      });
    }
  }
});

// ─────────────────────────────────────────────────
// Paid Routes (x402 payment required)
// Other agents pay per request to use these
// ─────────────────────────────────────────────────

// GET handlers for paid endpoints — so health checkers see them as reachable
for (const ep of ['send-airtime', 'send-data', 'pay-bill', 'buy-gift-card']) {
  app.get(`/${ep}`, (_req: Request, res: Response) => {
    res.json({
      service: ep,
      method: 'POST',
      paymentRequired: true,
      protocol: 'x402',
      status: 'available',
    });
  });
}

// Send airtime top-up via Reloadly
app.post('/send-airtime', paymentLimiter, x402Middleware, async (req: X402Request, res: Response) => {
  let receiptId = '';
  let serviceSucceeded = false; // V2 guard: only refund if Reloadly call itself failed
  try {
    const { phone, countryCode, amount, operatorId, useLocalAmount } = req.body;

    if (!phone || !countryCode || !amount) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['phone', 'countryCode', 'amount'],
        optional: ['operatorId', 'useLocalAmount'],
        description: 'amount is in USD unless useLocalAmount=true. Operator auto-detected from phone if not provided.',
        example: {
          phone: '08147658721',
          countryCode: 'NG',
          amount: 5,
          useLocalAmount: false,
        },
        helperEndpoints: {
          operators: 'GET /operators/:country - list operators',
        },
      });
      return;
    }

    // Sanitize and validate inputs
    const sanitizedPhone = sanitizePhone(phone);
    const sanitizedCountry = sanitizeCountryCode(countryCode);
    const sanitizedAmount = parseFloatSafe(amount, 'amount');
    // operatorId is optional for airtime (auto-detected from phone), but validate if provided
    const sanitizedOperatorId = operatorId != null ? requirePositiveInt(operatorId, 'operatorId') : undefined;

    // Create receipt before execution (tracks payment → service binding)
    if (req.x402) {
      receiptId = await createReceipt({
        paymentTxHash: req.x402.txHash,
        payer: req.x402.payer,
        paymentAmount: req.x402.totalPaid,
        paymentToken: PAYMENT_TOKEN_SYMBOL,
        paymentNetwork: CELO_CAIP2,
        serviceType: 'airtime',
        source: 'x402_api',
        serviceArgs: { phone: sanitizedPhone, countryCode: sanitizedCountry, amount: sanitizedAmount },
      });
    }

    const result = await sendAirtime({
      phone: sanitizedPhone,
      countryCode: sanitizedCountry,
      amount: sanitizedAmount,
      operatorId: sanitizedOperatorId,
      useLocalAmount: !!useLocalAmount,
    });
    serviceSucceeded = true; // Reloadly returned a response — do NOT refund on bookkeeping errors below

    // Update receipt with result
    const receiptStatus = reloadlyReceiptStatus(result.status);
    await updateReceipt(receiptId, {
      status: receiptStatus,
      reloadlyTransactionId: result.transactionId,
      reloadlyStatus: result.status,
      serviceResult: { operator: result.operatorName, deliveredAmount: result.deliveredAmount },
    });

    await recordTransaction({
      type: 'airtime_api',
      amount: result.requestedAmount,
      status: receiptStatus === 'success' ? 'success' : 'failed',
      metadata: {
        caller: req.x402?.payer,
        operator: result.operatorName,
        phone,
        country: countryCode,
        source: 'x402_api',
      },
    });

    // Add PAYMENT-RESPONSE header per x402 spec (settlement receipt)
    if (req.x402) {
      res.set('PAYMENT-RESPONSE', encodePaymentResponse(req.x402));
    }

    res.json({
      success: receiptStatus === 'success',
      transactionId: result.transactionId,
      operator: result.operatorName,
      requestedAmount: result.requestedAmount,
      requestedCurrency: result.requestedAmountCurrencyCode,
      deliveredAmount: result.deliveredAmount,
      deliveredCurrency: result.deliveredAmountCurrencyCode,
      phone: result.recipientPhone,
      status: result.status,
      pinDetail: result.pinDetail || null,
      x402: {
        totalPaid: req.x402?.totalPaid,
        breakdown: req.x402?.breakdown,
        paymentTx: req.x402?.txHash,
        network: CELO_CAIP2,
      },
    });
  } catch (error) {
    await handleX402Error(error, req, res, receiptId, serviceSucceeded);
  }
});

// Send data plan top-up via Reloadly
app.post('/send-data', paymentLimiter, x402Middleware, async (req: X402Request, res: Response) => {
  let receiptId = '';
  let serviceSucceeded = false;
  try {
    const { phone, countryCode, amount, operatorId, useLocalAmount } = req.body;

    if (!phone || !countryCode || !amount || !operatorId) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['phone', 'countryCode', 'amount', 'operatorId'],
        optional: ['useLocalAmount'],
        description: 'Get operatorId from GET /data-plans/:country. amount is in USD unless useLocalAmount=true.',
        example: {
          phone: '08147658721',
          countryCode: 'NG',
          amount: 2,
          operatorId: 646,
          useLocalAmount: false,
        },
        helperEndpoints: {
          dataPlans: 'GET /data-plans/:country - list data operators',
        },
      });
      return;
    }

    const sanitizedPhone = sanitizePhone(phone);
    const sanitizedCountry = sanitizeCountryCode(countryCode);
    const sanitizedAmount = parseFloatSafe(amount, 'amount');
    const sanitizedOperatorId = requirePositiveInt(operatorId, 'operatorId');

    if (req.x402) {
      receiptId = await createReceipt({
        paymentTxHash: req.x402.txHash,
        payer: req.x402.payer,
        paymentAmount: req.x402.totalPaid,
        paymentToken: PAYMENT_TOKEN_SYMBOL,
        paymentNetwork: CELO_CAIP2,
        serviceType: 'data',
        source: 'x402_api',
        serviceArgs: { phone: sanitizedPhone, countryCode: sanitizedCountry, amount: sanitizedAmount, operatorId: sanitizedOperatorId },
      });
    }

    const result = await sendData({
      phone: sanitizedPhone,
      countryCode: sanitizedCountry,
      amount: sanitizedAmount,
      operatorId: sanitizedOperatorId,
      useLocalAmount: !!useLocalAmount,
    });
    serviceSucceeded = true;

    const receiptStatus = reloadlyReceiptStatus(result.status);
    await updateReceipt(receiptId, {
      status: receiptStatus,
      reloadlyTransactionId: result.transactionId,
      reloadlyStatus: result.status,
      serviceResult: { operator: result.operatorName, deliveredAmount: result.deliveredAmount },
    });

    await recordTransaction({
      type: 'data_plan_api',
      amount: result.requestedAmount,
      status: receiptStatus === 'success' ? 'success' : 'failed',
      metadata: {
        caller: req.x402?.payer,
        operator: result.operatorName,
        phone,
        country: countryCode,
        source: 'x402_api',
      },
    });

    if (req.x402) res.set('PAYMENT-RESPONSE', encodePaymentResponse(req.x402));

    res.json({
      success: receiptStatus === 'success',
      transactionId: result.transactionId,
      operator: result.operatorName,
      requestedAmount: result.requestedAmount,
      requestedCurrency: result.requestedAmountCurrencyCode,
      deliveredAmount: result.deliveredAmount,
      deliveredCurrency: result.deliveredAmountCurrencyCode,
      phone: result.recipientPhone,
      status: result.status,
      pinDetail: result.pinDetail || null,
      x402: {
        totalPaid: req.x402?.totalPaid,
        breakdown: req.x402?.breakdown,
        paymentTx: req.x402?.txHash,
        network: CELO_CAIP2,
      },
    });
  } catch (error) {
    await handleX402Error(error, req, res, receiptId, serviceSucceeded);
  }
});

// Pay utility bill via Reloadly (electricity, water, TV, internet)
app.post('/pay-bill', paymentLimiter, x402Middleware, async (req: X402Request, res: Response) => {
  let receiptId = '';
  let serviceSucceeded = false;
  try {
    const { billerId, accountNumber, amount, useLocalAmount } = req.body;

    if (!billerId || !accountNumber || !amount) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['billerId', 'accountNumber', 'amount'],
        optional: ['useLocalAmount'],
        description: 'Get billerId from GET /billers/:country. useLocalAmount defaults to true.',
        example: {
          billerId: 5,
          accountNumber: '4223568280',
          amount: 1000,
          useLocalAmount: true,
        },
        helperEndpoints: {
          billers: 'GET /billers/:country?type=ELECTRICITY_BILL_PAYMENT',
        },
      });
      return;
    }

    // Validate and sanitize inputs
    const sanitizedBillerId = requirePositiveInt(billerId, 'billerId');
    const sanitizedAccount = sanitizeAccountNumber(accountNumber, 'accountNumber');
    const sanitizedAmount = parseFloatSafe(amount, 'amount');

    if (req.x402) {
      receiptId = await createReceipt({
        paymentTxHash: req.x402.txHash,
        payer: req.x402.payer,
        paymentAmount: req.x402.totalPaid,
        paymentToken: PAYMENT_TOKEN_SYMBOL,
        paymentNetwork: CELO_CAIP2,
        serviceType: 'bill_payment',
        source: 'x402_api',
        serviceArgs: { billerId: sanitizedBillerId, accountNumber: sanitizedAccount, amount: sanitizedAmount },
      });
    }

    const result = await payReloadlyBill({ billerId: sanitizedBillerId, accountNumber: sanitizedAccount, amount: sanitizedAmount, useLocalAmount: useLocalAmount !== false });
    serviceSucceeded = true;

    const billStatus = result.status === 'SUCCESSFUL' ? 'success' : result.status === 'FAILED' ? 'failed' : 'pending';
    await updateReceipt(receiptId, {
      status: billStatus,
      reloadlyTransactionId: result.id,
      reloadlyStatus: result.status,
      serviceResult: { referenceId: result.referenceId, message: result.message },
    });

    await recordTransaction({
      type: 'bill_payment_api',
      amount: sanitizedAmount,
      status: billStatus === 'success' ? 'success' : 'failed',
      metadata: {
        caller: req.x402?.payer,
        billerId: sanitizedBillerId,
        accountNumber: sanitizedAccount,
        source: 'x402_api',
      },
    });

    if (req.x402) res.set('PAYMENT-RESPONSE', encodePaymentResponse(req.x402));

    res.json({
      success: billStatus === 'success',
      transactionId: result.id,
      status: result.status,
      referenceId: result.referenceId,
      message: result.message,
      x402: {
        totalPaid: req.x402?.totalPaid,
        breakdown: req.x402?.breakdown,
        paymentTx: req.x402?.txHash,
        network: CELO_CAIP2,
      },
    });
  } catch (error) {
    await handleX402Error(error, req, res, receiptId, serviceSucceeded);
  }
});

// Buy a gift card
app.post('/buy-gift-card', paymentLimiter, x402Middleware, async (req: X402Request, res: Response) => {
  let receiptId = '';
  let serviceSucceeded = false;
  try {
    const { productId, amount, recipientEmail, quantity } = req.body;

    if (!productId || !amount || !recipientEmail) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['productId', 'amount', 'recipientEmail'],
        optional: ['quantity'],
        description: 'Get productId from GET /gift-cards/search?q=Steam or GET /gift-cards/:country',
        example: {
          productId: 120,
          amount: 25,
          recipientEmail: 'user@example.com',
          quantity: 1,
        },
        helperEndpoints: {
          search: 'GET /gift-cards/search?q=Steam&country=US',
          browse: 'GET /gift-cards/:country',
        },
      });
      return;
    }

    // Validate and sanitize inputs
    const sanitizedProductId = requirePositiveInt(productId, 'productId');
    const sanitizedAmount = parseFloatSafe(amount, 'amount');
    const sanitizedEmail = validateEmail(recipientEmail, 'recipientEmail');
    const sanitizedQuantity = quantity != null ? requirePositiveInt(quantity, 'quantity') : 1;
    if (sanitizedQuantity > 10) {
      res.status(400).json({ error: 'Invalid quantity: maximum 10 gift cards per purchase' });
      return;
    }

    if (req.x402) {
      receiptId = await createReceipt({
        paymentTxHash: req.x402.txHash,
        payer: req.x402.payer,
        paymentAmount: req.x402.totalPaid,
        paymentToken: PAYMENT_TOKEN_SYMBOL,
        paymentNetwork: CELO_CAIP2,
        serviceType: 'gift_card',
        source: 'x402_api',
        serviceArgs: { productId: sanitizedProductId, amount: sanitizedAmount, recipientEmail: sanitizedEmail, quantity: sanitizedQuantity },
      });
    }

    const result = await buyGiftCard({
      productId: sanitizedProductId,
      unitPrice: sanitizedAmount,
      recipientEmail: sanitizedEmail,
      quantity: sanitizedQuantity,
    });
    serviceSucceeded = true;

    await updateReceipt(receiptId, {
      status: 'success',
      reloadlyTransactionId: result.transactionId,
      reloadlyStatus: result.status,
      serviceResult: { brand: result.product.brand.brandName, amount: result.amount },
    });

    await recordTransaction({
      type: 'gift_card_api',
      amount: result.amount,
      status: 'success',
      metadata: {
        caller: req.x402?.payer,
        productId: sanitizedProductId,
        brand: result.product.brand.brandName,
        source: 'x402_api',
      },
    });

    // Auto-fetch redeem codes (may not be ready immediately for all cards)
    let redeemCodes = null;
    try {
      redeemCodes = await getGiftCardRedeemCode(result.transactionId);
    } catch {
      // Codes not ready yet — caller can retry with GET /gift-card-code/:id
    }

    if (req.x402) res.set('PAYMENT-RESPONSE', encodePaymentResponse(req.x402));

    res.json({
      success: true,
      transactionId: result.transactionId,
      amount: result.amount,
      currency: result.currencyCode,
      brand: result.product.brand.brandName,
      product: result.product.productName,
      status: result.status,
      redeemCodes: redeemCodes || null,
      redeemCodesNote: redeemCodes ? undefined : 'Codes not ready yet. Retry with GET /gift-card-code/' + result.transactionId,
      x402: {
        totalPaid: req.x402?.totalPaid,
        breakdown: req.x402?.breakdown,
        paymentTx: req.x402?.txHash,
        network: CELO_CAIP2,
      },
    });
  } catch (error) {
    await handleX402Error(error, req, res, receiptId, serviceSucceeded);
  }
});

// ─────────────────────────────────────────────────
// Admin Endpoints (API key protected)
// ─────────────────────────────────────────────────

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

function requireAdmin(req: Request, res: Response): boolean {
  if (!ADMIN_API_KEY) {
    res.status(503).json({ error: 'Admin endpoints not configured. Set ADMIN_API_KEY env var.' });
    return false;
  }
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Get receipt stats (overview)
app.get('/admin/receipts/stats', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const stats = await getReceiptStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json(errorResponse(error));
  }
});

// Get failed receipts (payment taken, service failed — need review/refund)
app.get('/admin/receipts/failed', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const receipts = await getFailedReceipts(limit);
    res.json({ receipts, total: receipts.length });
  } catch (error) {
    res.status(500).json(errorResponse(error));
  }
});

// Get receipts by payer address or telegram ID
app.get('/admin/receipts/payer/:payer', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const receipts = await getReceiptsByPayer(req.params.payer, limit);
    res.json({ payer: req.params.payer, receipts, total: receipts.length });
  } catch (error) {
    res.status(500).json(errorResponse(error));
  }
});

// Lookup receipt by payment tx hash
app.get('/admin/receipts/tx/:txHash', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const receipt = await getReceiptByTxHash(req.params.txHash);
    if (!receipt) {
      res.status(404).json({ error: 'Receipt not found' });
      return;
    }
    res.json(receipt);
  } catch (error) {
    res.status(500).json(errorResponse(error));
  }
});

// Get gift card redeem code after purchase (free — already paid at purchase time)
app.get('/gift-card-code/:transactionId', async (req: Request, res: Response) => {
  // V3 fix: require admin auth — codes are sensitive (redeemable value).
  // Buy-gift-card auto-fetches codes in its response. MCP has its own tool.
  if (!requireAdmin(req, res)) return;
  try {
    const transactionId = parseIntSafe(req.params.transactionId, 'transaction ID');
    const codes = await getGiftCardRedeemCode(transactionId);
    res.json({ transactionId, codes });
  } catch (error) {
    res.status(errorStatus(error)).json(errorResponse(error));
  }
});

/**
 * Start the HTTP API server
 */
export function startApiServer() {
  const port = parseInt(process.env.PORT || '3000');
  const server = app.listen(port, () => {
    console.log(`Toppa API server running on port ${port}`);
    console.log(`   Public:  GET  /                              - Agent info`);
    console.log(`   Public:  GET  /health                        - Health check`);
    console.log(`   Public:  GET  /countries                     - All supported countries`);
    console.log(`   Public:  GET  /countries/:cc/services        - Service availability for a country`);
    console.log(`   Public:  GET  /operators/:cc                 - Mobile operators by country`);
    console.log(`   Public:  GET  /data-plans/:cc                - Data plan operators by country`);
    console.log(`   Public:  GET  /billers/:cc                   - Utility billers by country`);
    console.log(`   Public:  GET  /gift-cards/search?q=Steam     - Search gift cards`);
    console.log(`   Public:  GET  /gift-cards/:cc                - Gift card brands by country`);
    console.log(`   Public:  GET  /promotions/:cc                - Active promotions by country`);
    console.log(`   Public:  GET  /transaction/:type/:id         - Check transaction status`);
    console.log(`   Public:  GET  /convert?amount=10&from=USD&country=NG - Currency conversion`);
    console.log(`   Public:  GET  /identity                      - ERC-8004 agent identity`);
    console.log(`   Public:  GET  /reputation                    - Agent reputation`);
    console.log(`   Public:  POST /api/verify                    - Self Protocol callback`);
    console.log(`   Paid:    POST /send-airtime                  - Send airtime top-up`);
    console.log(`   Paid:    POST /send-data                     - Send data plan top-up`);
    console.log(`   Paid:    POST /pay-bill                      - Pay utility bill`);
    console.log(`   Paid:    POST /buy-gift-card                 - Buy a gift card (includes codes)`);
    console.log(`   Admin:   GET  /gift-card-code/:id            - Retrieve gift card codes (API key required)`);
    console.log(`   Admin:   GET  /admin/receipts/*              - Receipt management (API key required)`);
    console.log(`   MCP:     POST /mcp                          - MCP Streamable HTTP (13 tools)`);
    console.log(`   A2A:     GET  /.well-known/agent.json       - A2A Agent Card`);
    console.log(`   A2A:     POST /a2a                          - A2A JSON-RPC endpoint`);
    const x = getX402Info();
    console.log(`   Payment: x402 (product + ${x.feePercent * 100}% fee in ${x.currency})`);
  });

  return server;
}
