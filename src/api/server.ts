import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { createX402PaymentRequest, verifyX402Payment, getX402Info, calculateTotalPayment } from '../blockchain/x402';
import {
  sendAirtime, getOperators, detectOperator,
  getDataOperators, sendData,
  getBillers, payBill as payReloadlyBill,
  getGiftCardProducts, searchGiftCards, buyGiftCard, getGiftCardRedeemCode,
  getCountries, getCountryServices, getAccountBalance, getPromotions,
  getAirtimeTransaction, getBillTransaction,
  ReloadlyError,
} from '../apis/reloadly';
import { recordTransaction, getAgentReputation, getAgentDetails, getAgentRegistrationFile } from '../blockchain/erc8004';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

// Trust Railway proxy for correct IP detection (rate limiting, logging)
app.set('trust proxy', true);

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

// CORS configuration
const corsOptions: cors.CorsOptions = {
  origin: isProduction
    ? (process.env.ALLOWED_ORIGINS?.split(',') || ['https://toppa.cc'])
    : '*', // Allow all origins in dev
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-PAYMENT', 'PAYMENT-SIGNATURE', 'X-402-PAYMENT'],
};
app.use(cors(corsOptions));

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
 * Sanitize country code input (prevent path traversal, injection)
 * Country codes should be 2-3 uppercase letters only
 */
function sanitizeCountryCode(code: string | string[]): string {
  // Handle array case (Express sometimes passes arrays if duplicate params)
  const input = Array.isArray(code) ? code[0] : code;
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid country code format');
  }
  const sanitized = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (sanitized.length < 2 || sanitized.length > 3) {
    throw new Error('Invalid country code format');
  }
  return sanitized;
}

/**
 * Sanitize phone number (allow digits, +, -, spaces only)
 */
function sanitizePhone(phone: string): string {
  if (typeof phone !== 'string') {
    throw new Error('Invalid phone number format');
  }
  const sanitized = phone.replace(/[^0-9+\-\s]/g, '');
  if (sanitized.length < 5 || sanitized.length > 20) {
    throw new Error('Invalid phone number format');
  }
  return sanitized;
}

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
  const parsed = parseFloat(value);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: must be a positive number`);
  }
  return parsed;
}

/**
 * Reloadly account balance cache
 * Refreshed every 5 minutes to cap max amounts in discovery endpoints
 */
let balanceCache: { balance: number; fetchedAt: number } | null = null;
const BALANCE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getReloadlyBalance(): Promise<number> {
  try {
    if (balanceCache && Date.now() - balanceCache.fetchedAt < BALANCE_CACHE_TTL) {
      return balanceCache.balance;
    }
    const result = await getAccountBalance();
    balanceCache = { balance: result.balance, fetchedAt: Date.now() };
    return result.balance;
  } catch (error) {
    console.error('Failed to fetch Reloadly balance:', error instanceof Error ? error.message : error);
    // Return a high default if balance fetch fails (don't block discovery)
    return 10000;
  }
}

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
 * Extract product amount from request body based on endpoint
 * Returns the USD amount the user wants to spend on the product
 */
function getProductAmount(req: Request): number | undefined {
  const body = req.body;
  if (!body) return undefined;

  // For POST endpoints: amount is in the body
  // The amount field represents the product cost in USD (or local currency)
  // For useLocalAmount=true, we still use the amount as approximate USD equivalent
  const amount = parseFloat(body.amount);
  if (!isNaN(amount) && amount > 0) return amount;

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
    const verification = await verifyX402Payment(paymentHeader, total);

    if (!verification.verified) {
      res.status(402).json({
        error: 'Payment verification failed',
        message: verification.error || 'The provided payment could not be verified',
        required: { total, productAmount: productAmount || 0, serviceFee },
      });
      return;
    }

    req.x402 = {
      verified: true,
      txHash: verification.txHash || paymentHeader,
      payer: verification.payer || 'unknown',
      totalPaid: verification.amount || total.toString(),
      breakdown: { total, productAmount: productAmount || 0, serviceFee },
    };

    next();
  } catch (error: any) {
    res.status(402).json({
      error: 'Payment verification error',
      message: error.message,
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
      example: 'curl -X POST https://toppa.cc/send-airtime -H "Content-Type: application/json" -d \'{"phone":"08147658721","countryCode":"NG","amount":5}\'',
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

// Agent image (SVG) for ERC-8004 registration / explorers
app.get('/agent-image.svg', (_req: Request, res: Response) => {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, '../../public/agent-image.svg'));
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
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
        isData: op.data,
        isBundle: op.bundle,
        denominationType: op.denominationType,
        fixedAmounts: (op as any).fixedAmounts || [],
        fixedAmountsDescriptions: (op as any).fixedAmountsDescriptions || {},
        localFixedAmounts: (op as any).localFixedAmounts || [],
        localFixedAmountsDescriptions: (op as any).localFixedAmountsDescriptions || {},
        minAmount: op.minAmount,
        maxAmount: capMaxAmount(op.maxAmount, balance),
        senderCurrency: op.senderCurrencyCode,
        localCurrency: op.destinationCurrencyCode,
      })),
      total: operators.length,
      accountBalance: balance,
    });
  } catch (error) {
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
  }
});

// Get full service availability for a country (airtime, data, bills, gift cards)
app.get('/countries/:code/services', async (req: Request, res: Response) => {
  try {
    const countryCode = sanitizeCountryCode(req.params.code);
    const services = await getCountryServices(countryCode);
    res.json(services);
  } catch (error) {
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
  }
});

// Agent identity (ERC-8004 on-chain details + registration file)
app.get('/identity', async (_req: Request, res: Response) => {
  try {
    const details = await getAgentDetails();
    const registrationFile = getAgentRegistrationFile();
    res.json({ agent: 'Toppa', onChain: details, registrationFile });
  } catch (error: any) {
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
  }
});

// ─────────────────────────────────────────────────
// Paid Routes (x402 payment required)
// Other agents pay per request to use these
// ─────────────────────────────────────────────────

// Send airtime top-up via Reloadly
app.post('/send-airtime', paymentLimiter, x402Middleware, async (req: X402Request, res: Response) => {
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

    const result = await sendAirtime({
      phone: sanitizedPhone,
      countryCode: sanitizedCountry,
      amount: sanitizedAmount,
      operatorId,
      useLocalAmount
    });

    await recordTransaction({
      type: 'airtime_api',
      amount: result.requestedAmount,
      status: result.status === 'SUCCESSFUL' ? 'success' : 'failed',
      metadata: {
        caller: req.x402?.payer,
        operator: result.operatorName,
        phone,
        country: countryCode,
        source: 'x402_api',
      },
    });

    res.json({
      success: result.status === 'SUCCESSFUL',
      transactionId: result.transactionId,
      operator: result.operatorName,
      requestedAmount: result.requestedAmount,
      requestedCurrency: result.requestedAmountCurrencyCode,
      deliveredAmount: result.deliveredAmount,
      deliveredCurrency: result.deliveredAmountCurrencyCode,
      phone: result.recipientPhone,
      status: result.status,
      x402: {
        totalPaid: req.x402?.totalPaid,
        breakdown: req.x402?.breakdown,
        paymentTx: req.x402?.txHash,
      },
    });
  } catch (error) {
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
  }
});

// Send data plan top-up via Reloadly
app.post('/send-data', paymentLimiter, x402Middleware, async (req: X402Request, res: Response) => {
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

    // Sanitize and validate inputs
    const sanitizedPhone = sanitizePhone(phone);
    const sanitizedCountry = sanitizeCountryCode(countryCode);
    const sanitizedAmount = parseFloatSafe(amount, 'amount');

    const result = await sendData({
      phone: sanitizedPhone,
      countryCode: sanitizedCountry,
      amount: sanitizedAmount,
      operatorId,
      useLocalAmount
    });

    await recordTransaction({
      type: 'data_plan_api',
      amount: result.requestedAmount,
      status: result.status === 'SUCCESSFUL' ? 'success' : 'failed',
      metadata: {
        caller: req.x402?.payer,
        operator: result.operatorName,
        phone,
        country: countryCode,
        source: 'x402_api',
      },
    });

    res.json({
      success: result.status === 'SUCCESSFUL',
      transactionId: result.transactionId,
      operator: result.operatorName,
      requestedAmount: result.requestedAmount,
      requestedCurrency: result.requestedAmountCurrencyCode,
      deliveredAmount: result.deliveredAmount,
      deliveredCurrency: result.deliveredAmountCurrencyCode,
      phone: result.recipientPhone,
      status: result.status,
      x402: {
        totalPaid: req.x402?.totalPaid,
        breakdown: req.x402?.breakdown,
        paymentTx: req.x402?.txHash,
      },
    });
  } catch (error) {
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
  }
});

// Pay utility bill via Reloadly (electricity, water, TV, internet)
app.post('/pay-bill', paymentLimiter, x402Middleware, async (req: X402Request, res: Response) => {
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

    const result = await payReloadlyBill({ billerId, accountNumber, amount, useLocalAmount });

    await recordTransaction({
      type: 'bill_payment_api',
      amount,
      status: 'success',
      metadata: {
        caller: req.x402?.payer,
        billerId,
        accountNumber,
        source: 'x402_api',
      },
    });

    res.json({
      success: true,
      transactionId: result.id,
      status: result.status,
      referenceId: result.referenceId,
      message: result.message,
      x402: {
        totalPaid: req.x402?.totalPaid,
        breakdown: req.x402?.breakdown,
        paymentTx: req.x402?.txHash,
      },
    });
  } catch (error) {
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
  }
});

// Buy a gift card
app.post('/buy-gift-card', paymentLimiter, x402Middleware, async (req: X402Request, res: Response) => {
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

    const result = await buyGiftCard({
      productId,
      unitPrice: amount,
      recipientEmail,
      quantity: quantity || 1,
    });

    await recordTransaction({
      type: 'gift_card_api',
      amount: result.amount,
      status: 'success',
      metadata: {
        caller: req.x402?.payer,
        productId,
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
      },
    });
  } catch (error) {
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
  }
});

// Get gift card redeem code after purchase (free — already paid at purchase time)
app.get('/gift-card-code/:transactionId', async (req: Request, res: Response) => {
  try {
    const transactionId = parseIntSafe(req.params.transactionId, 'transaction ID');
    const codes = await getGiftCardRedeemCode(transactionId);
    res.json({ transactionId, codes });
  } catch (error) {
    res.status(error instanceof ReloadlyError ? error.httpStatus : 500).json(errorResponse(error));
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
    console.log(`   Public:  GET  /identity                      - ERC-8004 agent identity`);
    console.log(`   Public:  GET  /reputation                    - Agent reputation`);
    console.log(`   Public:  POST /api/verify                    - Self Protocol callback`);
    console.log(`   Paid:    POST /send-airtime                  - Send airtime top-up`);
    console.log(`   Paid:    POST /send-data                     - Send data plan top-up`);
    console.log(`   Paid:    POST /pay-bill                      - Pay utility bill`);
    console.log(`   Paid:    POST /buy-gift-card                 - Buy a gift card (includes codes)`);
    console.log(`   Public:  GET  /gift-card-code/:id            - Retrieve gift card codes`);
    const x = getX402Info();
    console.log(`   Payment: x402 (product + ${x.feePercent * 100}% fee in ${x.currency})`);
  });

  return server;
}
