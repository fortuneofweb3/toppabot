import express, { Request, Response, NextFunction } from 'express';
import { createX402PaymentRequest, verifyX402Payment, chargeX402Fee } from '../blockchain/x402';
import { initiateOfframp, getCUSDtoNGNRate, getBestOffer, getOrder, confirmOrder, generateOfframpWidgetUrl, getRate, SUPPORTED_COUNTRIES, getCountries } from '../apis/fonbnk';
import { checkRates } from '../apis/rates';
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
  // Check for x402 payment header
  const paymentHeader = req.headers['x-402-payment'] as string;

  if (!paymentHeader) {
    // No payment provided - return 402 with payment instructions
    const paymentRequest = await createX402PaymentRequest({
      service: req.path,
      description: `Jara API: ${req.method} ${req.path}`,
      amount: parseFloat(process.env.X402_FEE_AMOUNT || '0.5'),
    });

    res.status(402).json(paymentRequest.body);
    return;
  }

  // Payment header provided - verify it
  try {
    const verification = await verifyX402Payment(paymentHeader);

    if (!verification.verified) {
      res.status(402).json({
        error: 'Payment verification failed',
        message: 'The provided transaction hash could not be verified',
      });
      return;
    }

    // Payment verified - attach to request and continue
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
    version: '1.0.0',
    description: 'Autonomous AI agent for crypto-to-cash conversion across Africa, Latin America, and Asia',
    chain: 'celo',
    protocol: 'x402',
    identity: 'ERC-8004',
    supportedCountries: Object.entries(SUPPORTED_COUNTRIES).map(([code, info]) => ({
      code,
      name: info.name,
      currency: info.currency,
      types: info.types,
    })),
    services: [
      'offramp (cUSD → local currency via bank or mobile money)',
      'bills (airtime, electricity, data, cable TV)',
      'rates (multi-source rate comparison)',
      'cards (virtual dollar card loading)',
    ],
    pricing: {
      currency: 'cUSD',
      feePerRequest: process.env.X402_FEE_AMOUNT || '0.5',
      protocol: 'x402 (HTTP 402 Payment Required)',
    },
    docs: {
      howToUse: 'Send request with x-402-payment header containing cUSD tx hash',
      example: 'curl -H "x-402-payment: 0xTX_HASH" https://jara.api/offramp',
    },
  });
});

// Supported countries list
app.get('/countries', async (_req: Request, res: Response) => {
  try {
    const countries = Object.entries(SUPPORTED_COUNTRIES).map(([code, info]) => ({
      code,
      ...info,
    }));
    res.json({ countries, total: countries.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current rates (free - helps agents decide)
app.get('/rates', async (req: Request, res: Response) => {
  try {
    const amount = parseFloat(req.query.amount as string) || 1;
    const country = (req.query.country as string) || 'NG';
    const rates = await checkRates(amount, country);
    res.json(rates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get rate for a specific country
app.get('/rates/:country', async (req: Request, res: Response) => {
  try {
    const country = req.params.country.toUpperCase();
    if (!SUPPORTED_COUNTRIES[country]) {
      res.status(400).json({
        error: `Unsupported country: ${country}`,
        supported: Object.keys(SUPPORTED_COUNTRIES),
      });
      return;
    }
    const rate = await getRate(country);
    res.json(rate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get best Fonbnk offer (includes required fields for bank/mobile money details)
app.get('/offer', async (req: Request, res: Response) => {
  try {
    const amount = parseFloat(req.query.amount as string) || undefined;
    const country = (req.query.country as string)?.toUpperCase() || undefined;
    const type = (req.query.type as string) || undefined;
    const offer = await getBestOffer({ amount, country, type });
    res.json(offer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get order status
app.get('/order/:id', async (req: Request, res: Response) => {
  try {
    const order = await getOrder(req.params.id);
    res.json(order);
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

// Offramp: Initiate cUSD → local currency transfer via Fonbnk
// Supports 15 countries via bank transfer or mobile money
// Flow: get offer → create order → return deposit address
// Caller then sends cUSD to deposit address, then calls /confirm-order
app.post('/offramp', x402Middleware, async (req: X402Request, res: Response) => {
  try {
    const { amount, senderAddress, bankDetails, country, type } = req.body;

    if (!amount || !senderAddress || !bankDetails) {
      // Get current offer to show required fields
      let requiredFields = {};
      try {
        const response = await getBestOffer({ amount, country, type });
        requiredFields = response.offer.requiredFields;
      } catch {}

      const countryCode = (country || 'NG').toUpperCase();
      const countryInfo = SUPPORTED_COUNTRIES[countryCode];

      res.status(400).json({
        error: 'Missing required fields',
        required: ['amount', 'senderAddress', 'bankDetails'],
        optional: ['country', 'type'],
        bankDetails: 'Object with fields from /offer requiredFields',
        requiredFields,
        supportedCountries: Object.keys(SUPPORTED_COUNTRIES),
        example: {
          amount: 20,
          senderAddress: '0xYourCeloAddress',
          country: countryCode,
          type: countryInfo?.types[0] || 'bank',
          bankDetails: {
            bankName: 'GTBank',
            accountNumber: '0123456789',
            accountName: 'John Doe',
          },
        },
      });
      return;
    }

    const result = await initiateOfframp({
      amount,
      senderAddress,
      bankDetails,
      country,
      type,
    });

    // Record on ERC-8004 for reputation
    await recordTransaction({
      type: 'offramp_api',
      amount,
      status: result.success ? 'success' : 'failed',
      metadata: {
        caller: req.x402?.payer,
        paymentTx: req.x402?.txHash,
        orderId: result.orderId,
        source: 'x402_api',
      },
    });

    res.json({
      ...result,
      x402: {
        feePaid: process.env.X402_FEE_AMOUNT || '0.5',
        paymentTx: req.x402?.txHash,
      },
      nextStep: 'Send cUSD to the depositAddress, then call POST /confirm-order with orderId and txHash',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Confirm order after cUSD has been sent to deposit address
app.post('/confirm-order', x402Middleware, async (req: X402Request, res: Response) => {
  try {
    const { orderId, txHash } = req.body;

    if (!orderId || !txHash) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['orderId', 'txHash'],
        description: 'Call this after sending cUSD to the deposit address from /offramp',
      });
      return;
    }

    const order = await confirmOrder({ orderId, txHash });

    await recordTransaction({
      type: 'offramp_confirm_api',
      amount: order.amountUsd,
      status: 'success',
      txHash,
      metadata: {
        caller: req.x402?.payer,
        orderId,
        source: 'x402_api',
      },
    });

    res.json({
      success: true,
      orderId: order._id,
      status: order.status,
      exchangeRate: order.exchangeRate,
      amountUsd: order.amountUsd,
      amountNgn: order.amountFiat,
      x402: {
        feePaid: process.env.X402_FEE_AMOUNT || '0.5',
        paymentTx: req.x402?.txHash,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Pay bills (airtime, electricity, data, cable TV)
app.post('/pay-bill', x402Middleware, async (req: X402Request, res: Response) => {
  try {
    const { type, provider, accountNumber, amount } = req.body;

    if (!type || !provider || !accountNumber || !amount) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['type', 'provider', 'accountNumber', 'amount'],
        supportedTypes: ['airtime', 'data', 'electricity', 'cable'],
        example: {
          type: 'airtime',
          provider: 'MTN',
          accountNumber: '08012345678',
          amount: 1000,
        },
      });
      return;
    }

    // TODO: Integrate with VTU.ng API
    // For now, record transaction and return mock
    await recordTransaction({
      type: `bill_${type}_api`,
      amount,
      status: 'success',
      metadata: {
        caller: req.x402?.payer,
        billType: type,
        provider,
        source: 'x402_api',
      },
    });

    res.json({
      success: true,
      type,
      provider,
      accountNumber,
      amount,
      status: 'completed',
      x402: {
        feePaid: process.env.X402_FEE_AMOUNT || '0.5',
        paymentTx: req.x402?.txHash,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Load virtual card
app.post('/load-card', x402Middleware, async (req: X402Request, res: Response) => {
  try {
    const { amount, currency } = req.body;

    if (!amount) {
      res.status(400).json({
        error: 'Missing required fields',
        required: ['amount'],
        optional: ['currency'],
      });
      return;
    }

    // TODO: Integrate with Sudo Africa API
    await recordTransaction({
      type: 'card_load_api',
      amount,
      status: 'success',
      metadata: {
        caller: req.x402?.payer,
        currency: currency || 'USD',
        source: 'x402_api',
      },
    });

    res.json({
      success: true,
      amount,
      currency: currency || 'USD',
      status: 'completed',
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
    console.log(`   Public:  GET  /              - Agent info`);
    console.log(`   Public:  GET  /countries     - Supported countries (${Object.keys(SUPPORTED_COUNTRIES).length})`);
    console.log(`   Public:  GET  /rates         - Current rates (?country=NG)`);
    console.log(`   Public:  GET  /rates/:country - Rate for specific country`);
    console.log(`   Public:  GET  /offer         - Best offer (?country=NG&type=bank)`);
    console.log(`   Public:  GET  /order/:id     - Order status`);
    console.log(`   Public:  GET  /reputation    - Agent reputation`);
    console.log(`   Paid:    POST /offramp       - Initiate cUSD → local currency offramp`);
    console.log(`   Paid:    POST /confirm-order - Confirm order with tx hash`);
    console.log(`   Paid:    POST /pay-bill      - Pay bills (airtime, utilities)`);
    console.log(`   Paid:    POST /load-card     - Load virtual card`);
    console.log(`   Payment: x402 (${process.env.X402_FEE_AMOUNT || '0.5'} cUSD per request)`);
  });
}
