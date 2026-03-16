import { z } from "zod";
import {
  getOperators,
  getDataOperators,
  getBillers,
  getGiftCardProducts, searchGiftCards, getGiftCardRedeemCode,
  getCountryServices, getPromotions,
} from "../apis/reloadly";
import { calculateTotalPayment } from "../blockchain/x402";

/**
 * Tool definition — lightweight replacement for LangChain DynamicStructuredTool.
 * Each tool has a name, description, Zod schema, and async function.
 */
interface Tool {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  func: (args: any) => Promise<string>;
}

/**
 * Tool 1: Send airtime top-up (170+ countries)
 * Payment-gated: returns order details for external payment flow.
 */
export const sendAirtimeTool: Tool = {
  name: "send_airtime",
  description: "Send mobile airtime top-up to any phone number across 170+ countries via Reloadly. Operator is auto-detected from the phone number. This is a PAID service — payment is required before execution.",
  schema: z.object({
    phone: z.string().describe("Recipient phone number (e.g. 08147658721)"),
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
    amount: z.number().describe("Amount in USD (or local currency if useLocalAmount is true)"),
    useLocalAmount: z.boolean().optional().nullable().describe("If true, amount is in local currency. Default false (USD)."),
  }),
  func: async ({ phone, countryCode, amount, useLocalAmount }) => {
    const { total } = calculateTotalPayment(amount);
    return JSON.stringify({
      status: 'payment_required',
      service: 'send_airtime',
      productAmount: amount,
      totalWithFee: total,
      currency: 'cUSD',
      details: { phone, countryCode, amount, useLocalAmount },
      message: `Airtime top-up requires ${total} cUSD payment (includes service fee). Use the order_confirmation flow for Telegram/A2A, or the x402 REST API / MCP endpoint for direct execution.`,
    });
  },
};

/**
 * Tool 2: Get mobile operators for a country
 */
export const getOperatorsTool: Tool = {
  name: "get_operators",
  description: "List available mobile operators for a country. Use this to show the user which operators are supported for airtime top-ups.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
  }),
  func: async ({ countryCode }) => {
    try {
      const operators = await getOperators(countryCode);
      return JSON.stringify(operators.map(op => ({
        id: op.operatorId,
        name: op.name,
        minAmount: op.minAmount,
        maxAmount: op.maxAmount,
        localCurrency: op.destinationCurrencyCode,
        type: op.data ? 'data' : op.bundle ? 'bundle' : 'airtime',
      })));
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 3: Get data plan operators for a country
 */
export const getDataPlansTool: Tool = {
  name: "get_data_plans",
  description: "List available mobile data plan operators for a country. Returns operators that offer data bundles. Use the operatorId from results to send data with send_data.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
  }),
  func: async ({ countryCode }) => {
    try {
      const operators = await getDataOperators(countryCode);
      return JSON.stringify(operators.map(op => ({
        operatorId: op.operatorId,
        name: op.name,
        isData: op.data,
        isBundle: op.bundle,
        denominationType: op.denominationType,
        minAmount: op.minAmount,
        maxAmount: op.maxAmount,
        localCurrency: op.destinationCurrencyCode,
      })));
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 4: Send data plan top-up
 * Payment-gated: returns order details for external payment flow.
 */
export const sendDataTool: Tool = {
  name: "send_data",
  description: "Send mobile data bundle to a phone number. Use get_data_plans first to find the operatorId. This is a PAID service — payment is required before execution.",
  schema: z.object({
    phone: z.string().describe("Recipient phone number"),
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
    amount: z.number().describe("Amount in USD (or local currency if useLocalAmount is true)"),
    operatorId: z.number().describe("Data operator ID from get_data_plans"),
    useLocalAmount: z.boolean().optional().nullable().describe("If true, amount is in local currency. Default false (USD)."),
  }),
  func: async ({ phone, countryCode, amount, operatorId, useLocalAmount }) => {
    const { total } = calculateTotalPayment(amount);
    return JSON.stringify({
      status: 'payment_required',
      service: 'send_data',
      productAmount: amount,
      totalWithFee: total,
      currency: 'cUSD',
      details: { phone, countryCode, amount, operatorId, useLocalAmount },
      message: `Data top-up requires ${total} cUSD payment (includes service fee). Use the order_confirmation flow for Telegram/A2A, or the x402 REST API / MCP endpoint for direct execution.`,
    });
  },
};

/**
 * Tool 5: Pay utility bill (electricity, water, TV, internet)
 * Payment-gated: returns order details for external payment flow.
 */
export const payBillTool: Tool = {
  name: "pay_bill",
  description: "Pay a utility bill (electricity, water, TV, internet) via Reloadly. First use get_billers to find the billerId. This is a PAID service — payment is required before execution.",
  schema: z.object({
    billerId: z.number().describe("Biller ID from get_billers"),
    accountNumber: z.string().describe("Customer's meter number, smartcard number, or account number"),
    amount: z.number().describe("Amount to pay (in local currency by default)"),
    useLocalAmount: z.boolean().optional().nullable().describe("If true (default), amount is in local currency. If false, amount is in USD."),
  }),
  func: async ({ billerId, accountNumber, amount, useLocalAmount }) => {
    const { total } = calculateTotalPayment(amount);
    return JSON.stringify({
      status: 'payment_required',
      service: 'pay_bill',
      productAmount: amount,
      totalWithFee: total,
      currency: 'cUSD',
      details: { billerId, accountNumber, amount, useLocalAmount },
      message: `Bill payment requires ${total} cUSD payment (includes service fee). Use the order_confirmation flow for Telegram/A2A, or the x402 REST API / MCP endpoint for direct execution.`,
    });
  },
};

/**
 * Tool 6: Get utility billers for a country
 */
export const getBillersTool: Tool = {
  name: "get_billers",
  description: "List available utility billers for a country. Types: ELECTRICITY_BILL_PAYMENT, WATER_BILL_PAYMENT, TV_BILL_PAYMENT, INTERNET_BILL_PAYMENT.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
    type: z.string().optional().nullable().describe("Bill type filter: ELECTRICITY_BILL_PAYMENT, WATER_BILL_PAYMENT, TV_BILL_PAYMENT, INTERNET_BILL_PAYMENT"),
  }),
  func: async ({ countryCode, type }) => {
    try {
      const billers = await getBillers({ countryCode, type: type as any });
      return JSON.stringify(billers.map(b => ({
        id: b.id,
        name: b.name,
        type: b.type,
        serviceType: b.serviceType,
        currency: b.localTransactionCurrencyCode,
        minAmount: b.minLocalTransactionAmount,
        maxAmount: b.maxLocalTransactionAmount,
      })));
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 7: Search gift cards by brand name
 */
export const searchGiftCardsTool: Tool = {
  name: "search_gift_cards",
  description: "Search for available gift cards by brand name (e.g. 'Amazon', 'Steam', 'Netflix', 'Spotify', 'PlayStation', 'Xbox', 'Uber', 'Google Play', 'Apple'). Returns product IDs needed to buy gift cards.",
  schema: z.object({
    query: z.string().describe("Brand or product name to search for (e.g. 'Steam', 'Netflix', 'Amazon')"),
    countryCode: z.string().optional().nullable().describe("Country ISO code to filter by (e.g. US, NG, KE)"),
  }),
  func: async ({ query, countryCode }) => {
    try {
      const results = await searchGiftCards(query, countryCode);
      return JSON.stringify(results.slice(0, 10).map(p => ({
        productId: p.productId,
        name: p.productName,
        brand: p.brand.brandName,
        country: p.country.isoName,
        currency: p.recipientCurrencyCode,
        denominationType: p.denominationType,
        fixedDenominations: p.fixedRecipientDenominations?.slice(0, 5),
        minAmount: p.minRecipientDenomination,
        maxAmount: p.maxRecipientDenomination,
      })));
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 8: Get gift cards for a country
 */
export const getGiftCardsTool: Tool = {
  name: "get_gift_cards",
  description: "List all available gift card brands for a specific country. Returns brands like Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, etc.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. US, NG, KE, GB)"),
  }),
  func: async ({ countryCode }) => {
    try {
      const products = await getGiftCardProducts(countryCode);
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
      return JSON.stringify({
        country: countryCode.toUpperCase(),
        totalProducts: products.length,
        brands: Array.from(brands.values()).slice(0, 20),
      });
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 9: Buy a gift card
 * Payment-gated: returns order details for external payment flow.
 */
export const buyGiftCardTool: Tool = {
  name: "buy_gift_card",
  description: "Purchase a gift card. Use search_gift_cards first to get the productId. This is a PAID service — payment is required before execution.",
  schema: z.object({
    productId: z.number().describe("Product ID from search_gift_cards or get_gift_cards"),
    amount: z.number().describe("Amount/denomination for the gift card (in recipient currency)"),
    recipientEmail: z.string().describe("Email to deliver the gift card to"),
    quantity: z.number().optional().nullable().describe("Number of cards to buy. Default 1."),
  }),
  func: async ({ productId, amount, recipientEmail, quantity }) => {
    const { total } = calculateTotalPayment(amount);
    return JSON.stringify({
      status: 'payment_required',
      service: 'buy_gift_card',
      productAmount: amount,
      totalWithFee: total,
      currency: 'cUSD',
      details: { productId, amount, recipientEmail, quantity: quantity || 1 },
      message: `Gift card purchase requires ${total} cUSD payment (includes service fee). Use the order_confirmation flow for Telegram/A2A, or the x402 REST API / MCP endpoint for direct execution.`,
    });
  },
};

/**
 * Tool 10: Get gift card redeem code
 */
export const getGiftCardCodeTool: Tool = {
  name: "get_gift_card_code",
  description: "Get the redeem code/PIN for a purchased gift card. Call this after buy_gift_card with the transactionId.",
  schema: z.object({
    transactionId: z.number().describe("Transaction ID from buy_gift_card"),
  }),
  func: async ({ transactionId }) => {
    try {
      const codes = await getGiftCardRedeemCode(transactionId);
      return JSON.stringify({ codes });
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 11: Check country service availability
 */
export const checkCountryTool: Tool = {
  name: "check_country",
  description: "Check what services (airtime, data, bills, gift cards) are available in a specific country. Use this FIRST when a user mentions a country to know what you can offer them.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, US, GB, SI)"),
  }),
  func: async ({ countryCode }) => {
    try {
      const services = await getCountryServices(countryCode);
      return JSON.stringify(services);
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 12: Get active promotions for a country
 */
export const getPromotionsTool: Tool = {
  name: "get_promotions",
  description: "Get active operator promotions and bonus deals for a country. Useful to tell users about extra value they can get (e.g. 'buy X get 2X bonus').",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
  }),
  func: async ({ countryCode }) => {
    try {
      const promotions = await getPromotions(countryCode);
      return JSON.stringify(promotions.slice(0, 10).map((p: any) => ({
        operatorId: p.operatorId,
        title: p.title || p.title2,
        description: p.description?.slice(0, 200),
        startDate: p.startDate,
        endDate: p.endDate,
      })));
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

// Paid tools — execute real transactions via Reloadly (cost money)
export const paidTools = [
  sendAirtimeTool,
  sendDataTool,
  payBillTool,
  buyGiftCardTool,
];

// Free/discovery tools — no cost, just lookups
export const freeTools = [
  getOperatorsTool,
  getDataPlansTool,
  getBillersTool,
  searchGiftCardsTool,
  getGiftCardsTool,
  getGiftCardCodeTool,
  checkCountryTool,
  getPromotionsTool,
];

// Paid tool names for fast lookup
export const PAID_TOOL_NAMES = new Set(paidTools.map(t => t.name));

// All tools — paid tools return payment_required (never call Reloadly directly)
export const tools: Tool[] = [...freeTools, ...paidTools];
