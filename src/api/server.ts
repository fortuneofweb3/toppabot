import express, { Request, Response, NextFunction } from 'express';
import { createX402PaymentRequest, verifyX402Payment, chargeX402Fee } from '../blockchain/x402';
import {
  sendAirtime, getOperators, detectOperator,
  getBillers, payBill as payReloadlyBill,
  getGiftCardProducts, searchGiftCards, buyGiftCard, getGiftCardRedeemCode,
} from '../apis/reloadly';
import { recordTransaction, getAgentReputation } from '../blockchain/erc8004';

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────
// x402 Payment Middleware
// Gates paid endpoints behind HTTP 402 Payment Required
// ─────────────────────────────────────────────────

interface X402Request extends Request {
  x402?: {
    verified: boolean;
    txHash: string;
    payer: string;
  };
}

async function x402Middleware(req: X402Request, res: Response, next: NextFunction) {
  const paymentHeader = req.headers['x-402-payment'] as string;

  if (!paymentHeader) {
    const paymentRequest = await createX402PaymentRequest({
      service: req.path,
      description: `Jara API: ${req.method} ${req.path}`,
      amount: parseFloat(process.env.X402_FEE_AMOUNT || '0.5'),
    });

    res.status(402).json(paymentRequest.body);
    return;
  }

  try {
    const verification = await verifyX402Payment(paymentHeader);

    if (!verification.verified) {
      res.status(402).json({
        error: 'Payment verification failed',
        message: 'The provided transaction hash could not be verified',
      });
      return;
    }

    req.x402 = {
      verified: true,
      txHash: paymentHeader,
      payer: req.headers['x-402-payer'] as string || 'unknown',
    };

    next();
  } catch (error) {
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
  res.json({
    agent: 'Jara',
    version: '2.0.0',
    description: 'AI agent for digital goods and utility payments across 170+ countries on Celo',
    chain: 'celo',
    protocol: 'x402',
    identity: 'ERC-8004',
    services: [
      'airtime (mobile top-ups across 170+ countries)',
      'bills (electricity, water, TV, internet payments)',
      'gift_cards (300+ brands: Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, Apple, Google Play, prepaid Visa/Mastercard)',
    ],
    pricing: {
      currency: 'cUSD',
      feePerRequest: process.env.X402_FEE_AMOUNT || '0.5',
      protocol: 'x402 (HTTP 402 Payment Required)',
    },
    docs: {
      howToUse: 'Send request with x-402-payment header containing cUSD tx hash',
      example: 'curl -H "x-402-payment: 0xTX_HASH" https://jara.api/send-airtime',
    },
  });
});

// Get mobile operators for a country (for airtime)
app.get('/operators/:country', async (req: Request, res: Response) => {
  try {
    const operators = await getOperators(req.params.country);
    res.json({ country: req.params.country.toUpperCase(), operators, total: operators.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get utility billers for a country
app.get('/billers/:country', async (req: Request, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    const billers = await getBillers({
      countryCode: req.params.country,
      type: type as any,
    });
    res.json({ country: req.params.country.toUpperCase(), billers, total: billers.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get gift card brands for a country
app.get('/gift-cards/:country', async (req: Request, res: Response) => {
  try {
    const products = await getGiftCardProducts(req.params.country.toUpperCase());
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
    res.json({
      country: req.params.country.toUpperCase(),
      totalProducts: products.length,
      brands: Array.from(brands.values()),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search gift cards by brand name
app.get('/gift-cards/search', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    const countryCode = req.query.country as string | undefined;

    if (!query) {
      res.status(400).json({ error: 'Missing query parameter: q' });
      return;
    }

    const results = await searchGiftCards(query, countryCode);
    res.json({
      query,
      results: results.slice(0, 20).map(p => ({
        productId: p.productId,
        name: p.productName,
        brand: p.brand.brandName,
        country: p.country.isoName,
        currency: p.recipientCurrencyCode,
        denominationType: p.denominationType,
        fixedDenominations: p.fixedRecipientDenominations?.slice(0, 5),
        minAmount: p.minRecipientDenomination,
        maxAmount: p.maxRecipientDenomination,
      })),
      total: results.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Agent reputation (public - shows trust score)
app.get('/reputation', async (_req: Request, res: Response) => {
  try {
    const reputation = await getAgentReputation();
    res.json({
      agent: 'Jara',
      ...reputation,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────
// Paid Routes (x402 payment required)
// Other agents pay per request to use these
// ─────────────────────────────────────────────────

// Send airtime top-up via Reloadly
app.post('/send-airtime', x402Middleware, async (req: X402Request, res: Response) => {
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

    const result = await sendAirtime({ phone, countryCode, amount, operatorId, useLocalAmount });

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
        feePaid: process.env.X402_FEE_AMOUNT || '0.5',
        paymentTx: req.x402?.txHash,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pay utility bill via Reloadly (electricity, water, TV, internet)
app.post('/pay-bill', x402Middleware, async (req: X402Request, res: Response) => {
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
        feePaid: process.env.X402_FEE_AMOUNT || '0.5',
        paymentTx: req.x402?.txHash,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buy a gift card
app.post('/buy-gift-card', x402Middleware, async (req: X402Request, res: Response) => {
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

    res.json({
      success: true,
      transactionId: result.transactionId,
      amount: result.amount,
      currency: result.currencyCode,
      brand: result.product.brand.brandName,
      product: result.product.productName,
      status: result.status,
      redeemCodeEndpoint: `GET /gift-card-code/${result.transactionId}`,
      x402: {
        feePaid: process.env.X402_FEE_AMOUNT || '0.5',
        paymentTx: req.x402?.txHash,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get gift card redeem code after purchase
app.get('/gift-card-code/:transactionId', x402Middleware, async (req: X402Request, res: Response) => {
  try {
    const transactionId = parseInt(req.params.transactionId);
    if (isNaN(transactionId)) {
      res.status(400).json({ error: 'Invalid transactionId' });
      return;
    }

    const codes = await getGiftCardRedeemCode(transactionId);
    res.json({
      transactionId,
      codes,
      x402: {
        feePaid: process.env.X402_FEE_AMOUNT || '0.5',
        paymentTx: req.x402?.txHash,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Start the HTTP API server
 */
export function startApiServer() {
  const port = parseInt(process.env.PORT || '3000');
  app.listen(port, () => {
    console.log(`Jara API server running on port ${port}`);
    console.log(`   Public:  GET  /                          - Agent info`);
    console.log(`   Public:  GET  /operators/:cc              - Mobile operators by country`);
    console.log(`   Public:  GET  /billers/:cc                - Utility billers by country`);
    console.log(`   Public:  GET  /gift-cards/:cc             - Gift card brands by country`);
    console.log(`   Public:  GET  /gift-cards/search?q=Steam  - Search gift cards`);
    console.log(`   Public:  GET  /reputation                 - Agent reputation`);
    console.log(`   Paid:    POST /send-airtime               - Send airtime top-up`);
    console.log(`   Paid:    POST /pay-bill                   - Pay utility bill`);
    console.log(`   Paid:    POST /buy-gift-card              - Buy a gift card`);
    console.log(`   Paid:    GET  /gift-card-code/:id         - Get gift card redeem code`);
    console.log(`   Payment: x402 (${process.env.X402_FEE_AMOUNT || '0.5'} cUSD per request)`);
  });
}
