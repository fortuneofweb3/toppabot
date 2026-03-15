import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { checkRates } from "../apis/rates";
import { initiateOfframp, getBestOffer, confirmOrder, getOrder, getRate, generateOfframpWidgetUrl, SUPPORTED_COUNTRIES } from "../apis/fonbnk";
import { payBill } from "../apis/vtu";
import { loadVirtualCard } from "../apis/sudo";
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
    bankDetails: z.record(z.string()).describe("Recipient details object with fields from get_offer requiredFields (e.g. bankName, accountNumber, accountName for bank; or phone number for mobile money)"),
    country: z.string().optional().describe("Country ISO code (e.g. NG, KE, ZA, GH). Defaults to NG"),
    type: z.string().optional().describe("Offramp type: 'bank' or 'mobile_money'. Defaults to country's primary type"),
  }),
  func: async ({ amount, senderAddress, bankDetails, country, type }) => {
    try {
      const result = await initiateOfframp({
        amount,
        senderAddress,
        bankDetails,
        country,
        type,
      });

      await recordTransaction({
        type: 'offramp',
        amount,
        status: 'success',
        metadata: { orderId: result.orderId },
      });

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
  description: "Confirm a Fonbnk offramp order after the user has sent cUSD to the deposit address. Provide the orderId from initiate_offramp and the on-chain transaction hash.",
  schema: z.object({
    orderId: z.string().describe("Order ID from initiate_offramp"),
    txHash: z.string().describe("On-chain transaction hash of the cUSD transfer"),
  }),
  func: async ({ orderId, txHash }) => {
    try {
      const order = await confirmOrder({ orderId, txHash });

      await recordTransaction({
        type: 'offramp_confirm',
        amount: order.amountUsd,
        status: 'success',
        txHash,
        metadata: { orderId },
      });

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
  description: "Generate a Fonbnk widget URL where the user can complete the offramp in their browser. Alternative to the API flow.",
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
 * Tool 7: Pay bills (electricity, airtime, data, cable TV)
 */
export const payBillTool = new DynamicStructuredTool({
  name: "pay_bill",
  description: "Pay Nigerian utility bills: electricity, airtime, data bundles, cable TV (DStv, GOtv)",
  schema: z.object({
    billType: z.enum(['electricity', 'airtime', 'data', 'cable']).describe("Type of bill"),
    provider: z.string().describe("Provider name (e.g., 'EEDC', 'MTN', 'DStv')"),
    amount: z.number().describe("Amount in Naira"),
    accountNumber: z.string().describe("Meter number, phone number, or smartcard number"),
  }),
  func: async ({ billType, provider, amount, accountNumber }) => {
    try {
      const result = await payBill({
        type: billType,
        provider,
        amount,
        accountNumber,
      });

      await recordTransaction({
        type: 'bill_payment',
        amount,
        status: 'success',
        metadata: { billType, provider },
      });

      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 8: Load virtual dollar card
 */
export const loadCardTool = new DynamicStructuredTool({
  name: "load_virtual_card",
  description: "Load a virtual USD/NGN card for international payments (Netflix, Amazon, etc.)",
  schema: z.object({
    amount: z.number().describe("Amount in USD to load"),
    currency: z.enum(['USD', 'NGN']).describe("Card currency"),
    cardId: z.string().optional().describe("Existing card ID, or create new if not provided"),
  }),
  func: async ({ amount, currency, cardId }) => {
    try {
      const result = await loadVirtualCard({
        amount,
        currency,
        cardId,
      });

      await recordTransaction({
        type: 'card_load',
        amount,
        status: 'success',
      });

      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});

/**
 * Tool 9: Verify user with SelfClaw
 */
export const verifySelfClawTool = new DynamicStructuredTool({
  name: "verify_selfclaw",
  description: "Verify user is human using SelfClaw ZK proof of humanity. Required before first transaction.",
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

/**
 * Tool 10: Get user balance
 */
export const getBalanceTool = new DynamicStructuredTool({
  name: "get_balance",
  description: "Check user's cUSD balance on Celo",
  schema: z.object({
    address: z.string().describe("User's Celo wallet address"),
  }),
  func: async ({ address }) => {
    // TODO: Implement with viem
    return JSON.stringify({ balance: 0, currency: 'cUSD' });
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
  payBillTool,
  loadCardTool,
  verifySelfClawTool,
  getBalanceTool,
];
