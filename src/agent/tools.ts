import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { checkRates } from "../apis/rates";
import { initiateOfframp, getBestOffer, confirmOrder, getOrder, getRate, generateOfframpWidgetUrl, SUPPORTED_COUNTRIES } from "../apis/fonbnk";
import { sendAirtime, getOperators, detectOperator, getBillers, payBill as payReloadlyBill } from "../apis/reloadly";
import { verifySelfClaw } from "../apis/selfclaw";
import { recordTransaction } from "../blockchain/erc8004";

/**
 * Tool 1: Check conversion rates across multiple sources
 */
export const checkRatesTool = new DynamicStructuredTool({
  name: "check_rates",
  description: "Check cUSD → local currency conversion rates for any supported country",
  schema: z.object({
    amount: z.number().describe("Amount in cUSD to convert"),
    country: z.string().optional().describe("Country ISO code (e.g. NG, KE, ZA). Defaults to NG"),
  }),
  func: async ({ amount, country }) => {
    const rates = await checkRates(amount, country);
    return JSON.stringify(rates);
  },
});

/**
 * Tool 2: Get best Fonbnk offer (exchange rate + required fields)
 */
export const getOfferTool = new DynamicStructuredTool({
  name: "get_offer",
  description: `Get the best Fonbnk offer for cUSD → local currency conversion. Returns exchange rate, fees, and required recipient detail fields. Supports ${Object.keys(SUPPORTED_COUNTRIES).length} countries: ${Object.entries(SUPPORTED_COUNTRIES).map(([code, info]) => `${code} (${info.name})`).join(', ')}.`,
  schema: z.object({
    amount: z.number().optional().describe("Optional amount in USD to get offer for"),
    country: z.string().optional().describe("Country ISO code (e.g. NG, KE, ZA, GH). Defaults to NG"),
    type: z.string().optional().describe("Offramp type: 'bank' or 'mobile_money'. Defaults to country's primary type"),
  }),
  func: async ({ amount, country, type }) => {
    try {
      const offer = await getBestOffer({ amount, country, type });
      return JSON.stringify(offer);
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 3: Initiate offramp - cUSD → local currency via Fonbnk
 */
export const offrampTool = new DynamicStructuredTool({
  name: "initiate_offramp",
  description: "Initiate a cUSD → local currency offramp via Fonbnk. Supports bank transfers and mobile money across 15 countries. Creates an order and returns a deposit address where the user must send cUSD. After sending, call confirm_order with the transaction hash.",
  schema: z.object({
    amount: z.number().describe("Amount in USD to convert"),
    senderAddress: z.string().describe("User's Celo wallet address that will send cUSD"),
    bankDetails: z.record(z.string()).describe("Recipient details object with fields from get_offer requiredFields"),
    country: z.string().optional().describe("Country ISO code (e.g. NG, KE, ZA, GH). Defaults to NG"),
    type: z.string().optional().describe("Offramp type: 'bank' or 'mobile_money'. Defaults to country's primary type"),
  }),
  func: async ({ amount, senderAddress, bankDetails, country, type }) => {
    try {
      const result = await initiateOfframp({ amount, senderAddress, bankDetails, country, type });
      await recordTransaction({ type: 'offramp', amount, status: 'success', metadata: { orderId: result.orderId } });
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 4: Confirm offramp order after cUSD has been sent
 */
export const confirmOrderTool = new DynamicStructuredTool({
  name: "confirm_order",
  description: "Confirm a Fonbnk offramp order after the user has sent cUSD to the deposit address.",
  schema: z.object({
    orderId: z.string().describe("Order ID from initiate_offramp"),
    txHash: z.string().describe("On-chain transaction hash of the cUSD transfer"),
  }),
  func: async ({ orderId, txHash }) => {
    try {
      const order = await confirmOrder({ orderId, txHash });
      await recordTransaction({ type: 'offramp_confirm', amount: order.amountUsd, status: 'success', txHash, metadata: { orderId } });
      return JSON.stringify(order);
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 5: Check order status
 */
export const getOrderTool = new DynamicStructuredTool({
  name: "get_order_status",
  description: "Check the status of a Fonbnk offramp order by its ID",
  schema: z.object({
    orderId: z.string().describe("Order ID to check"),
  }),
  func: async ({ orderId }) => {
    try {
      const order = await getOrder(orderId);
      return JSON.stringify(order);
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 6: Generate offramp widget URL
 */
export const getWidgetUrlTool = new DynamicStructuredTool({
  name: "get_offramp_widget_url",
  description: "Generate a Fonbnk widget URL where the user can complete the offramp in their browser.",
  schema: z.object({
    amount: z.number().describe("Amount to offramp"),
    countryIsoCode: z.string().optional().describe("Country ISO code (e.g. NG, KE). Defaults to NG"),
  }),
  func: async ({ amount, countryIsoCode }) => {
    const url = generateOfframpWidgetUrl({ amount, countryIsoCode });
    return JSON.stringify({ url, description: 'Open this URL to complete the offramp in your browser' });
  },
});

/**
 * Tool 7: Send airtime top-up via Reloadly (150+ countries)
 */
export const sendAirtimeTool = new DynamicStructuredTool({
  name: "send_airtime",
  description: "Send mobile airtime top-up to any phone number across 150+ countries via Reloadly. Operator is auto-detected from the phone number.",
  schema: z.object({
    phone: z.string().describe("Recipient phone number (e.g. 08147658721)"),
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
    amount: z.number().describe("Amount in USD (or local currency if useLocalAmount is true)"),
    useLocalAmount: z.boolean().optional().describe("If true, amount is in local currency. Default false (USD)."),
  }),
  func: async ({ phone, countryCode, amount, useLocalAmount }) => {
    try {
      const result = await sendAirtime({ phone, countryCode, amount, useLocalAmount });
      await recordTransaction({ type: 'airtime', amount: result.requestedAmount, status: 'success', metadata: { operator: result.operatorName, phone } });
      return JSON.stringify({
        success: result.status === 'SUCCESSFUL',
        operator: result.operatorName,
        requestedAmount: result.requestedAmount,
        requestedCurrency: result.requestedAmountCurrencyCode,
        deliveredAmount: result.deliveredAmount,
        deliveredCurrency: result.deliveredAmountCurrencyCode,
        transactionId: result.transactionId,
      });
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 8: Get mobile operators for a country
 */
export const getOperatorsTool = new DynamicStructuredTool({
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
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 9: Pay utility bill via Reloadly (electricity, water, TV, internet)
 */
export const payBillTool = new DynamicStructuredTool({
  name: "pay_bill",
  description: "Pay a utility bill (electricity, water, TV, internet) via Reloadly. First use get_billers to find the billerId, then call this with the biller ID and account number.",
  schema: z.object({
    billerId: z.number().describe("Biller ID from get_billers"),
    accountNumber: z.string().describe("Customer's meter number, smartcard number, or account number"),
    amount: z.number().describe("Amount to pay (in local currency by default)"),
    useLocalAmount: z.boolean().optional().describe("If true (default), amount is in local currency. If false, amount is in USD."),
  }),
  func: async ({ billerId, accountNumber, amount, useLocalAmount }) => {
    try {
      const result = await payReloadlyBill({ billerId, accountNumber, amount, useLocalAmount });
      await recordTransaction({ type: 'bill_payment', amount, status: 'success', metadata: { billerId, accountNumber } });
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 10: Get utility billers for a country
 */
export const getBillersTool = new DynamicStructuredTool({
  name: "get_billers",
  description: "List available utility billers for a country. Types: ELECTRICITY_BILL_PAYMENT, WATER_BILL_PAYMENT, TV_BILL_PAYMENT, INTERNET_BILL_PAYMENT.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
    type: z.string().optional().describe("Bill type filter: ELECTRICITY_BILL_PAYMENT, WATER_BILL_PAYMENT, TV_BILL_PAYMENT, INTERNET_BILL_PAYMENT"),
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
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 11: Verify user with SelfProtocol
 */
export const verifySelfClawTool = new DynamicStructuredTool({
  name: "verify_selfclaw",
  description: "Verify user is human using SelfProtocol ZK proof of humanity.",
  schema: z.object({
    telegramId: z.string().describe("User's Telegram ID"),
  }),
  func: async ({ telegramId }) => {
    try {
      const result = await verifySelfClaw(telegramId);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ error: error.message, verified: false });
    }
  },
});

// Export all tools as array for LangGraph
export const tools = [
  checkRatesTool,
  getOfferTool,
  offrampTool,
  confirmOrderTool,
  getOrderTool,
  getWidgetUrlTool,
  sendAirtimeTool,
  getOperatorsTool,
  payBillTool,
  getBillersTool,
  verifySelfClawTool,
];
