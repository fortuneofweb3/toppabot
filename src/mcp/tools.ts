import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  sendAirtime, getOperators,
  getDataOperators, sendData,
  getBillers, payBill as payReloadlyBill,
  getGiftCardProducts, searchGiftCards, buyGiftCard, getGiftCardRedeemCode,
  getCountryServices, getPromotions,
  getFxRate,
} from '../apis/reloadly';
import { verifyX402Payment, calculateTotalPayment, getX402Info, PAYMENT_TOKEN_SYMBOL } from '../blockchain/x402';
import { reservePaymentHash, releasePaymentHash } from '../blockchain/replay-guard';
import { recordTransaction } from '../blockchain/erc8004';
import { createReceipt, updateReceipt } from '../blockchain/service-receipts';
import { CELO_CAIP2 } from '../shared/constants';
import { getCachedReloadlyBalance } from '../shared/balance-cache';
import { sanitizeCountryCode, sanitizePhone } from '../shared/sanitize';

/**
 * Verify x402 payment for paid MCP tools.
 * Returns payment_required info if no hash provided, or verifies the hash on-chain.
 * Uses MongoDB-backed replay guard for atomic hash deduplication.
 */
async function requirePayment(paymentTxHash: string | undefined, amount: number) {
  const { total, serviceFee } = calculateTotalPayment(amount);
  const x402Info = getX402Info();

  if (!paymentTxHash || paymentTxHash.trim() === '') {
    return {
      error: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'payment_required',
          protocol: 'x402',
          productAmount: amount,
          serviceFee,
          total,
          currency: x402Info.currency,
          chain: x402Info.chain,
          asset: x402Info.asset,
          payTo: x402Info.payTo,
          instructions: `Send ${total} ${x402Info.currency} to ${x402Info.payTo} on ${x402Info.chain}, then retry with the tx hash in the paymentTxHash parameter.`,
        }),
      }],
    };
  }

  // Reserve hash atomically in MongoDB — prevents replay attacks
  const isReserved = await reservePaymentHash(paymentTxHash, 'mcp');
  if (!isReserved) {
    return {
      error: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'payment_already_used',
          message: 'This transaction hash has already been used for a previous service. Submit a new payment.',
        }),
      }],
    };
  }

  const verification = await verifyX402Payment(paymentTxHash, total);
  if (!verification.verified) {
    // Release the hash so it can potentially be retried
    await releasePaymentHash(paymentTxHash);
    return {
      error: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'payment_verification_failed',
          message: verification.error,
        }),
      }],
    };
  }

  return { error: false, verification };
}

/**
 * Register all 13 tools on an MCP server instance.
 */
export function registerMcpTools(server: McpServer) {
  // ─── FREE TOOLS ───

  server.tool(
    'get_operators',
    'List available mobile operators for a country (for airtime top-ups)',
    { countryCode: z.string().describe('Country ISO code (e.g. NG, KE, GH)') },
    async ({ countryCode }) => {
      try {
        const sanitizedCountry = sanitizeCountryCode(countryCode);
        const [operators, balance] = await Promise.all([
          getOperators(sanitizedCountry),
          getCachedReloadlyBalance(),
        ]);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(operators.map(op => ({
              id: op.operatorId,
              name: op.name,
              denominationType: op.denominationType,
              currency: 'USD',
              fixedAmountsUSD: (op.fixedAmounts || []).filter(a => a <= balance),
              fixedAmountsDescriptions: op.fixedAmountsDescriptions || {},
              suggestedAmountsUSD: (op.suggestedAmounts || []).filter(a => a <= balance),
              mostPopularAmountUSD: op.mostPopularAmount && op.mostPopularAmount <= balance ? op.mostPopularAmount : null,
              minAmountUSD: op.minAmount,
              maxAmountUSD: op.maxAmount ? Math.min(op.maxAmount, balance) : balance,
              localCurrency: op.destinationCurrencyCode,
              fxRate: op.fx?.rate || null,
              type: op.data ? 'data' : op.bundle ? 'bundle' : 'airtime',
            }))),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );

  server.tool(
    'get_data_plans',
    'List available mobile data plan operators for a country. Use operatorId from results to send data. All amounts in USD.',
    { countryCode: z.string().describe('Country ISO code (e.g. NG, KE, GH)') },
    async ({ countryCode }) => {
      try {
        const sanitizedCountry = sanitizeCountryCode(countryCode);
        const [operators, balance] = await Promise.all([
          getDataOperators(sanitizedCountry),
          getCachedReloadlyBalance(),
        ]);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(operators.map(op => ({
              operatorId: op.operatorId,
              name: op.name,
              isData: op.data,
              isBundle: op.bundle,
              denominationType: op.denominationType,
              currency: 'USD',
              fixedAmountsUSD: (op.fixedAmounts || []).filter(a => a <= balance),
              fixedAmountsDescriptions: op.fixedAmountsDescriptions || {},
              suggestedAmountsUSD: (op.suggestedAmounts || []).filter(a => a <= balance),
              mostPopularAmountUSD: op.mostPopularAmount && op.mostPopularAmount <= balance ? op.mostPopularAmount : null,
              minAmountUSD: op.minAmount,
              maxAmountUSD: op.maxAmount ? Math.min(op.maxAmount, balance) : balance,
              localCurrency: op.destinationCurrencyCode,
              fxRate: op.fx?.rate || null,
            }))),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );

  server.tool(
    'get_billers',
    'List utility billers for a country. Types: ELECTRICITY_BILL_PAYMENT, WATER_BILL_PAYMENT, TV_BILL_PAYMENT, INTERNET_BILL_PAYMENT.',
    {
      countryCode: z.string().describe('Country ISO code (e.g. NG, KE, GH)'),
      type: z.string().optional().describe('Bill type filter: ELECTRICITY_BILL_PAYMENT, WATER_BILL_PAYMENT, TV_BILL_PAYMENT, INTERNET_BILL_PAYMENT'),
    },
    async ({ countryCode, type }) => {
      try {
        const sanitizedCountry = sanitizeCountryCode(countryCode);
        const [billers, balance] = await Promise.all([
          getBillers({ countryCode: sanitizedCountry, type: type as any }),
          getCachedReloadlyBalance(),
        ]);
        const mappedBillers = billers.map(b => {
          const fxRate = b.fx?.rate || 1;
          return {
            id: b.id,
            name: b.name,
            type: b.type,
            serviceType: b.serviceType,
            currency: 'USD',
            minAmountUSD: b.internationalAmountSupported
              ? (b.minInternationalTransactionAmount || Math.round((b.minLocalTransactionAmount / fxRate) * 100) / 100)
              : Math.round((b.minLocalTransactionAmount / fxRate) * 100) / 100,
            maxAmountUSD: b.internationalAmountSupported
              ? (b.maxInternationalTransactionAmount || Math.round((b.maxLocalTransactionAmount / fxRate) * 100) / 100)
              : Math.round((b.maxLocalTransactionAmount / fxRate) * 100) / 100,
            localCurrency: b.localTransactionCurrencyCode,
            minLocalAmount: b.minLocalTransactionAmount,
            maxLocalAmount: b.maxLocalTransactionAmount,
            fxRate,
          };
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(mappedBillers),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );

  server.tool(
    'search_gift_cards',
    'Search for gift cards by brand name (Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, etc.). Returns product IDs for purchasing.',
    {
      query: z.string().describe("Brand or product name to search (e.g. 'Steam', 'Netflix', 'Amazon')"),
      countryCode: z.string().optional().describe('Country ISO code to filter by (e.g. US, NG)'),
    },
    async ({ query, countryCode }) => {
      try {
        const sanitizedCountry = countryCode ? sanitizeCountryCode(countryCode) : undefined;
        const [results, balance] = await Promise.all([
          searchGiftCards(query, sanitizedCountry),
          getCachedReloadlyBalance(),
        ]);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(results.slice(0, 10).map(p => ({
              productId: p.productId,
              name: p.productName,
              brand: p.brand.brandName,
              category: p.category?.name || null,
              country: p.country.isoName,
              recipientCurrency: p.recipientCurrencyCode,
              denominationType: p.denominationType,
              currency: 'USD',
              fixedAmountsUSD: (p.fixedSenderDenominations || [])
                .filter((d: number) => d <= balance)
                .slice(0, 10),
              fixedRecipientAmounts: (p.fixedRecipientDenominations || []).slice(0, 10),
              minAmountUSD: p.minSenderDenomination,
              maxAmountUSD: p.maxSenderDenomination
                ? Math.min(p.maxSenderDenomination, balance)
                : balance,
              redeemInstruction: p.redeemInstruction?.concise || null,
            }))),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );

  server.tool(
    'get_gift_cards',
    'List all available gift card brands for a country.',
    { countryCode: z.string().describe('Country ISO code (e.g. US, NG, KE, GB)') },
    async ({ countryCode }) => {
      try {
        const sanitizedCountry = sanitizeCountryCode(countryCode);
        const [products, balance] = await Promise.all([
          getGiftCardProducts(sanitizedCountry),
          getCachedReloadlyBalance(),
        ]);
        const brands = new Map<string, { brandName: string; products: number; minPrice: number; maxPrice: number; currency: string }>();
        for (const p of products) {
          const existing = brands.get(p.brand.brandName);
          const min = p.minSenderDenomination || p.fixedSenderDenominations?.[0] || 0;
          const max = p.maxSenderDenomination || p.fixedSenderDenominations?.slice(-1)[0] || 0;
          const cappedMax = Math.min(max, balance);
          if (min > balance) continue; // Skip brands entirely above our balance
          if (existing) {
            existing.products++;
            existing.minPrice = Math.min(existing.minPrice, min);
            existing.maxPrice = Math.max(existing.maxPrice, cappedMax);
          } else {
            brands.set(p.brand.brandName, { brandName: p.brand.brandName, products: 1, minPrice: min, maxPrice: cappedMax, currency: p.senderCurrencyCode });
          }
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              country: countryCode.toUpperCase(),
              totalProducts: products.length,
              brands: Array.from(brands.values()).slice(0, 20),
            }),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );

  server.tool(
    'get_gift_card_code',
    'Get the redeem code/PIN for a purchased gift card. Call after buy_gift_card.',
    { transactionId: z.number().int().positive().describe('Transaction ID from buy_gift_card') },
    async ({ transactionId }) => {
      try {
        const codes = await getGiftCardRedeemCode(transactionId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ codes }) }] };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );

  server.tool(
    'check_country',
    'Check what services (airtime, data, bills, gift cards) are available in a country.',
    { countryCode: z.string().describe('Country ISO code (e.g. NG, KE, US, GB)') },
    async ({ countryCode }) => {
      try {
        const sanitizedCountry = sanitizeCountryCode(countryCode);
        const services = await getCountryServices(sanitizedCountry);
        return { content: [{ type: 'text' as const, text: JSON.stringify(services) }] };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );

  server.tool(
    'get_promotions',
    'Get active operator promotions and bonus deals for a country.',
    { countryCode: z.string().describe('Country ISO code (e.g. NG, KE, GH)') },
    async ({ countryCode }) => {
      try {
        const sanitizedCountry = sanitizeCountryCode(countryCode);
        const promotions = await getPromotions(sanitizedCountry);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(promotions.slice(0, 10).map((p: any) => ({
              operatorId: p.operatorId,
              title: p.title || p.title2,
              description: p.description?.slice(0, 200),
              startDate: p.startDate,
              endDate: p.endDate,
            }))),
          }],
        };
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );

  server.tool(
    'convert_currency',
    'Convert between USD (cUSD) and a country\'s local currency using live FX rates. Useful for price conversions.',
    {
      amount: z.number().positive().describe('Amount to convert'),
      fromCurrency: z.enum(['USD', 'LOCAL']).describe("'USD' to convert USD→local, 'LOCAL' to convert local→USD"),
      countryCode: z.string().min(2).max(3).describe('Country ISO code for the local currency (e.g. NG, KE, GH)'),
    },
    async ({ amount, fromCurrency, countryCode }) => {
      try {
        const sanitizedCountry = sanitizeCountryCode(countryCode);
        const fxData = await getFxRate(sanitizedCountry);
        if (!fxData) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `No FX rate available for country ${countryCode}` }) }] };
        }

        const { rate, currencyCode } = fxData;

        if (fromCurrency === 'USD') {
          const localAmount = Math.round(amount * rate * 100) / 100;
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                from: { amount, currency: 'USD' },
                to: { amount: localAmount, currency: currencyCode },
                fxRate: rate,
                description: `${amount} USD = ${localAmount.toLocaleString()} ${currencyCode}`,
              }),
            }],
          };
        } else {
          const usdAmount = Math.round((amount / rate) * 100) / 100;
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                from: { amount, currency: currencyCode },
                to: { amount: usdAmount, currency: 'USD' },
                fxRate: rate,
                description: `${amount.toLocaleString()} ${currencyCode} = ${usdAmount} USD`,
              }),
            }],
          };
        }
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }] };
      }
    },
  );

  // ─── PAID TOOLS (require x402 payment) ───

  server.tool(
    'send_airtime',
    'Send mobile airtime top-up to any phone number (170+ countries). Amount in USD. Requires x402 payment — include paymentTxHash.',
    {
      phone: z.string().min(5).max(20).describe('Recipient phone number (e.g. 08147658721)'),
      countryCode: z.string().min(2).max(3).describe('Country ISO code (e.g. NG, KE, GH)'),
      amount: z.number().positive().describe('Amount in USD (cUSD). Use fixedAmountsUSD from get_operators.'),
      useLocalAmount: z.boolean().optional().describe('If true, amount is in local currency. Default false (USD). Prefer USD.'),
      paymentTxHash: z.string().optional().describe('x402 payment transaction hash (cUSD/USDC on Celo). Required for execution.'),
    },
    async ({ phone, countryCode, amount, useLocalAmount, paymentTxHash }) => {
      const paymentCheck = await requirePayment(paymentTxHash, amount);
      if (paymentCheck.error) return paymentCheck as any;

      let receiptId = '';
      try {
        const sanitizedPhone = sanitizePhone(phone);
        const sanitizedCountry = sanitizeCountryCode(countryCode);

        // Track payment → service binding
        if (paymentCheck.verification) {
          receiptId = await createReceipt({
            paymentTxHash: paymentCheck.verification.txHash || paymentTxHash!,
            payer: paymentCheck.verification.payer || 'unknown',
            paymentAmount: paymentCheck.verification.amount || amount.toString(),
            paymentToken: PAYMENT_TOKEN_SYMBOL,
            paymentNetwork: CELO_CAIP2,
            serviceType: 'airtime',
            source: 'mcp',
            serviceArgs: { phone: sanitizedPhone, countryCode: sanitizedCountry, amount },
          });
        }

        const result = await sendAirtime({ phone: sanitizedPhone, countryCode: sanitizedCountry, amount, useLocalAmount });
        const success = result.status === 'SUCCESSFUL';

        await updateReceipt(receiptId, {
          status: success ? 'success' : 'failed',
          reloadlyTransactionId: result.transactionId,
          reloadlyStatus: result.status,
          serviceResult: { operator: result.operatorName, deliveredAmount: result.deliveredAmount },
        });

        await recordTransaction({
          type: 'airtime_mcp',
          amount: result.requestedAmount,
          status: success ? 'success' : 'failed',
          metadata: { source: 'mcp', operator: result.operatorName, phone, country: countryCode },
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success,
              operator: result.operatorName,
              requestedAmount: result.requestedAmount,
              requestedCurrency: result.requestedAmountCurrencyCode,
              deliveredAmount: result.deliveredAmount,
              deliveredCurrency: result.deliveredAmountCurrencyCode,
              transactionId: result.transactionId,
              pinDetail: result.pinDetail || null,
            }),
          }],
        };
      } catch (error: any) {
        // Payment was verified but service failed — track it
        if (receiptId) {
          await updateReceipt(receiptId, { status: 'failed', error: error.message });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message, paymentConsumed: true, note: 'Payment was verified but service execution failed. Contact support with your payment tx hash.' }) }] };
      }
    },
  );

  server.tool(
    'send_data',
    'Send mobile data bundle. Use get_data_plans first to find operatorId. Amount in USD. Requires x402 payment — include paymentTxHash.',
    {
      phone: z.string().min(5).max(20).describe('Recipient phone number'),
      countryCode: z.string().min(2).max(3).describe('Country ISO code (e.g. NG, KE, GH)'),
      amount: z.number().positive().describe('Amount in USD (cUSD). Use fixedAmountsUSD from get_data_plans.'),
      operatorId: z.number().int().positive().describe('Data operator ID from get_data_plans'),
      useLocalAmount: z.boolean().optional().describe('If true, amount is in local currency. Default false (USD). Prefer USD.'),
      paymentTxHash: z.string().optional().describe('x402 payment transaction hash (cUSD/USDC on Celo). Required for execution.'),
    },
    async ({ phone, countryCode, amount, operatorId, useLocalAmount, paymentTxHash }) => {
      const paymentCheck = await requirePayment(paymentTxHash, amount);
      if (paymentCheck.error) return paymentCheck as any;

      let receiptId = '';
      try {
        const sanitizedPhone = sanitizePhone(phone);
        const sanitizedCountry = sanitizeCountryCode(countryCode);

        if (paymentCheck.verification) {
          receiptId = await createReceipt({
            paymentTxHash: paymentCheck.verification.txHash || paymentTxHash!,
            payer: paymentCheck.verification.payer || 'unknown',
            paymentAmount: paymentCheck.verification.amount || amount.toString(),
            paymentToken: PAYMENT_TOKEN_SYMBOL,
            paymentNetwork: CELO_CAIP2,
            serviceType: 'data',
            source: 'mcp',
            serviceArgs: { phone: sanitizedPhone, countryCode: sanitizedCountry, amount, operatorId },
          });
        }

        const result = await sendData({ phone: sanitizedPhone, countryCode: sanitizedCountry, amount, operatorId, useLocalAmount });
        const success = result.status === 'SUCCESSFUL';

        await updateReceipt(receiptId, {
          status: success ? 'success' : 'failed',
          reloadlyTransactionId: result.transactionId,
          reloadlyStatus: result.status,
          serviceResult: { operator: result.operatorName, deliveredAmount: result.deliveredAmount },
        });

        await recordTransaction({
          type: 'data_plan_mcp',
          amount: result.requestedAmount,
          status: success ? 'success' : 'failed',
          metadata: { source: 'mcp', operator: result.operatorName, phone, country: countryCode },
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success,
              operator: result.operatorName,
              requestedAmount: result.requestedAmount,
              requestedCurrency: result.requestedAmountCurrencyCode,
              deliveredAmount: result.deliveredAmount,
              deliveredCurrency: result.deliveredAmountCurrencyCode,
              transactionId: result.transactionId,
              pinDetail: result.pinDetail || null,
            }),
          }],
        };
      } catch (error: any) {
        if (receiptId) await updateReceipt(receiptId, { status: 'failed', error: error.message });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message, paymentConsumed: true, note: 'Payment was verified but service execution failed. Contact support with your payment tx hash.' }) }] };
      }
    },
  );

  server.tool(
    'pay_bill',
    'Pay a utility bill (electricity, water, TV, internet). Use get_billers first. Amount in USD. Requires x402 payment — include paymentTxHash.',
    {
      billerId: z.number().int().positive().describe('Biller ID from get_billers'),
      accountNumber: z.string().min(1).max(50).describe("Customer's meter/smartcard/account number"),
      amount: z.number().positive().describe('Amount in USD (cUSD). Use fxRate from get_billers to convert local amounts.'),
      useLocalAmount: z.boolean().optional().describe('If true, amount is in local currency. Default false (USD). Prefer USD.'),
      paymentTxHash: z.string().optional().describe('x402 payment transaction hash (cUSD/USDC on Celo). Required for execution.'),
    },
    async ({ billerId, accountNumber, amount, useLocalAmount, paymentTxHash }) => {
      const paymentCheck = await requirePayment(paymentTxHash, amount);
      if (paymentCheck.error) return paymentCheck as any;

      let receiptId = '';
      try {
        if (paymentCheck.verification) {
          receiptId = await createReceipt({
            paymentTxHash: paymentCheck.verification.txHash || paymentTxHash!,
            payer: paymentCheck.verification.payer || 'unknown',
            paymentAmount: paymentCheck.verification.amount || amount.toString(),
            paymentToken: PAYMENT_TOKEN_SYMBOL,
            paymentNetwork: CELO_CAIP2,
            serviceType: 'bill_payment',
            source: 'mcp',
            serviceArgs: { billerId, accountNumber, amount },
          });
        }

        const result = await payReloadlyBill({ billerId, accountNumber, amount, useLocalAmount });

        await updateReceipt(receiptId, {
          status: 'success',
          reloadlyTransactionId: result.id,
          reloadlyStatus: result.status,
          serviceResult: { referenceId: result.referenceId, message: result.message },
        });

        await recordTransaction({
          type: 'bill_payment_mcp',
          amount,
          status: 'success',
          metadata: { source: 'mcp', billerId, accountNumber },
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error: any) {
        if (receiptId) await updateReceipt(receiptId, { status: 'failed', error: error.message });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message, paymentConsumed: true, note: 'Payment was verified but service execution failed. Contact support with your payment tx hash.' }) }] };
      }
    },
  );

  server.tool(
    'buy_gift_card',
    'Purchase a gift card. Use search_gift_cards first. Amount in USD. Requires x402 payment — include paymentTxHash. Use get_gift_card_code after to get redeem code.',
    {
      productId: z.number().int().positive().describe('Product ID from search_gift_cards or get_gift_cards'),
      amount: z.number().positive().describe('Amount in USD (cUSD). Use fixedAmountsUSD from search_gift_cards.'),
      recipientEmail: z.string().email().describe('Email to deliver the gift card to'),
      quantity: z.number().int().min(1).max(10).optional().describe('Number of cards (1-10). Default 1.'),
      paymentTxHash: z.string().optional().describe('x402 payment transaction hash (cUSD/USDC on Celo). Required for execution.'),
    },
    async ({ productId, amount, recipientEmail, quantity, paymentTxHash }) => {
      const paymentCheck = await requirePayment(paymentTxHash, amount);
      if (paymentCheck.error) return paymentCheck as any;

      let receiptId = '';
      try {
        if (paymentCheck.verification) {
          receiptId = await createReceipt({
            paymentTxHash: paymentCheck.verification.txHash || paymentTxHash!,
            payer: paymentCheck.verification.payer || 'unknown',
            paymentAmount: paymentCheck.verification.amount || amount.toString(),
            paymentToken: PAYMENT_TOKEN_SYMBOL,
            paymentNetwork: CELO_CAIP2,
            serviceType: 'gift_card',
            source: 'mcp',
            serviceArgs: { productId, amount, recipientEmail, quantity: quantity || 1 },
          });
        }

        const result = await buyGiftCard({
          productId,
          unitPrice: amount,
          recipientEmail,
          quantity: quantity || 1,
        });

        await updateReceipt(receiptId, {
          status: 'success',
          reloadlyTransactionId: result.transactionId,
          reloadlyStatus: result.status,
          serviceResult: { brand: result.product.brand.brandName, amount: result.amount },
        });

        await recordTransaction({
          type: 'gift_card_mcp',
          amount: result.amount,
          status: 'success',
          metadata: { source: 'mcp', productId, brand: result.product.brand.brandName },
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              transactionId: result.transactionId,
              amount: result.amount,
              currency: result.currencyCode,
              brand: result.product.brand.brandName,
              product: result.product.productName,
              status: result.status,
              note: 'Use get_gift_card_code with the transactionId to retrieve the redeem code.',
            }),
          }],
        };
      } catch (error: any) {
        if (receiptId) await updateReceipt(receiptId, { status: 'failed', error: error.message });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message, paymentConsumed: true, note: 'Payment was verified but service execution failed. Contact support with your payment tx hash.' }) }] };
      }
    },
  );
}
