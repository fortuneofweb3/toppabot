import { z } from "zod";
import {
  getOperators,
  getDataOperators,
  detectOperator,
  getBillers,
  getGiftCardProducts, searchGiftCards, getGiftCardRedeemCode,
  getCountryServices, getPromotions,
  getFxRate,
} from "../apis/reloadly";
import { calculateTotalPayment } from "../blockchain/x402";
import { getCachedReloadlyBalance } from "../shared/balance-cache";
import { getReceiptByReloadlyId } from "../blockchain/service-receipts";
import { createScheduledTask, getUserScheduledTasks, cancelScheduledTask } from "./scheduler";
import { saveUserGoal, getUserGoals, removeUserGoal } from "./goals";
import { setUserCountry } from "./user-activity";
import { sanitizeCountryCode, sanitizePhone } from "../shared/sanitize";

/**
 * Tool definition — lightweight replacement for LangChain DynamicStructuredTool.
 * Each tool has a name, description, Zod schema, and async function.
 */

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  func: (args: any, ctx?: SchedulingContext | null) => Promise<string>;
}

/**
 * Tool 1: Send airtime top-up (170+ countries)
 * Payment-gated: returns order details for external payment flow.
 */
export const sendAirtimeTool: Tool = {
  name: "send_airtime",
  description: "Send airtime top-up to a phone number. Amount in cUSD.",
  schema: z.object({
    phone: z.string().describe("Recipient phone number"),
    countryCode: z.string().describe("Country ISO code"),
    amount: z.number().describe("Amount in cUSD"),
  }),
  func: async ({ phone, countryCode, amount }) => {
    phone = sanitizePhone(phone);
    countryCode = sanitizeCountryCode(countryCode);
    const { total } = calculateTotalPayment(amount);
    return JSON.stringify({
      status: 'payment_required',
      service: 'send_airtime',
      productAmount: amount,
      totalWithFee: total,
      currency: 'cUSD',
      details: { phone, countryCode, amount, useLocalAmount: false },
      message: `Airtime top-up requires ${total} cUSD payment (includes service fee). Use the order_confirmation flow for Telegram/A2A, or the x402 REST API / MCP endpoint for direct execution.`,
    });
  },
};

/**
 * Tool 2: Get mobile operators for a country
 */
export const getOperatorsTool: Tool = {
  name: "get_operators",
  description: "List mobile operators for a country with supported top-up amounts.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code"),
  }),
  func: async ({ countryCode }, ctx) => {
    try {
      countryCode = sanitizeCountryCode(countryCode);
      if (ctx) setUserCountry(ctx.userId, countryCode);
      const operators = await getOperators(countryCode);
      const balance = await getCachedReloadlyBalance();
      return JSON.stringify(operators.map(op => {
        const fxRate = op.fx?.rate || 1;
        const descs = op.fixedAmountsDescriptions || {};
        // Compact plans: only include description when it exists, limit to 10
        const plans = (op.fixedAmounts || []).filter(a => a <= balance).slice(0, 10).map(usd => {
          const desc = descs[usd.toString()] || descs[usd.toFixed(2)];
          const plan: any = { cUSD: usd, local: Math.round(usd * fxRate) };
          if (desc) plan.desc = desc;
          return plan;
        });
        return {
          id: op.operatorId,
          name: op.name,
          type: op.denominationType,
          plans,
          minCUSD: op.minAmount,
          maxCUSD: op.maxAmount ? Math.min(op.maxAmount, balance) : balance,
          cur: op.destinationCurrencyCode,
          fx: fxRate,
        };
      }));
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
  description: "List data plan operators for a country with available bundles.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code"),
  }),
  func: async ({ countryCode }, ctx) => {
    try {
      countryCode = sanitizeCountryCode(countryCode);
      if (ctx) setUserCountry(ctx.userId, countryCode);
      const operators = await getDataOperators(countryCode);
      const balance = await getCachedReloadlyBalance();
      return JSON.stringify(operators.map(op => {
        const fxRate = op.fx?.rate || 1;
        const descs = op.fixedAmountsDescriptions || {};
        // Compact plans: only include description when it exists, limit to 10
        const plans = (op.fixedAmounts || []).filter(a => a <= balance).slice(0, 10).map(usd => {
          const desc = descs[usd.toString()] || descs[usd.toFixed(2)];
          const plan: any = { cUSD: usd, local: Math.round(usd * fxRate) };
          if (desc) plan.desc = desc;
          return plan;
        });
        return {
          id: op.operatorId,
          name: op.name,
          type: op.denominationType,
          plans,
          minCUSD: op.minAmount,
          maxCUSD: op.maxAmount ? Math.min(op.maxAmount, balance) : balance,
          cur: op.destinationCurrencyCode,
          fx: fxRate,
        };
      }));
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
  description: "Send a data bundle to a phone number. Amount in cUSD.",
  schema: z.object({
    phone: z.string().describe("Recipient phone number"),
    countryCode: z.string().describe("Country ISO code"),
    amount: z.number().describe("Amount in cUSD"),
    operatorId: z.number().describe("Operator ID from get_data_plans"),
  }),
  func: async ({ phone, countryCode, amount, operatorId }) => {
    phone = sanitizePhone(phone);
    countryCode = sanitizeCountryCode(countryCode);
    const { total } = calculateTotalPayment(amount);
    return JSON.stringify({
      status: 'payment_required',
      service: 'send_data',
      productAmount: amount,
      totalWithFee: total,
      currency: 'cUSD',
      details: { phone, countryCode, amount, operatorId, useLocalAmount: false },
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
  description: "Pay a utility bill (electricity, water, TV, internet). Amount in cUSD.",
  schema: z.object({
    billerId: z.number().describe("Biller ID from get_billers"),
    accountNumber: z.string().describe("Meter/smartcard/account number"),
    amount: z.number().describe("Amount in cUSD"),
  }),
  func: async ({ billerId, accountNumber, amount }) => {
    const { total } = calculateTotalPayment(amount);
    return JSON.stringify({
      status: 'payment_required',
      service: 'pay_bill',
      productAmount: amount,
      totalWithFee: total,
      currency: 'cUSD',
      details: { billerId, accountNumber, amount, useLocalAmount: false },
      message: `Bill payment requires ${total} cUSD payment (includes service fee). Use the order_confirmation flow for Telegram/A2A, or the x402 REST API / MCP endpoint for direct execution.`,
    });
  },
};

/**
 * Tool 6: Get utility billers for a country
 */
export const getBillersTool: Tool = {
  name: "get_billers",
  description: "List utility billers for a country (electricity, water, TV, internet).",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code"),
    type: z.string().optional().nullable().describe("Bill type filter: ELECTRICITY_BILL_PAYMENT, WATER_BILL_PAYMENT, TV_BILL_PAYMENT, INTERNET_BILL_PAYMENT"),
  }),
  func: async ({ countryCode, type }, ctx) => {
    try {
      countryCode = sanitizeCountryCode(countryCode);
      if (ctx) setUserCountry(ctx.userId, countryCode);
      const billers = await getBillers({ countryCode, type: type as any });
      return JSON.stringify(billers.map(b => {
        const fxRate = b.fx?.rate || 1;
        return {
          id: b.id,
          name: b.name,
          type: b.type,
          serviceType: b.serviceType,
          currency: 'cUSD',
          minAmount: b.internationalAmountSupported
            ? (b.minInternationalTransactionAmount || Math.round((b.minLocalTransactionAmount / fxRate) * 100) / 100)
            : Math.round((b.minLocalTransactionAmount / fxRate) * 100) / 100,
          maxAmount: b.internationalAmountSupported
            ? (b.maxInternationalTransactionAmount || Math.round((b.maxLocalTransactionAmount / fxRate) * 100) / 100)
            : Math.round((b.maxLocalTransactionAmount / fxRate) * 100) / 100,
          localCurrency: b.localTransactionCurrencyCode,
          minLocalAmount: b.minLocalTransactionAmount,
          maxLocalAmount: b.maxLocalTransactionAmount,
          fxRate,
        };
      }));
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
  description: "Search gift cards by brand name (e.g. Amazon, Steam, Netflix).",
  schema: z.object({
    query: z.string().describe("Brand name to search (e.g. Steam, Netflix)"),
    countryCode: z.string().optional().nullable().describe("Country ISO code filter"),
  }),
  func: async ({ query, countryCode }) => {
    try {
      if (countryCode) countryCode = sanitizeCountryCode(countryCode);
      const results = await searchGiftCards(query, countryCode);
      const balance = await getCachedReloadlyBalance();
      return JSON.stringify(results.slice(0, 10).map(p => ({
        productId: p.productId,
        name: p.productName,
        brand: p.brand.brandName,
        category: p.category?.name || null,
        country: p.country.isoName,
        recipientCurrency: p.recipientCurrencyCode,
        denominationType: p.denominationType,
        fixedAmountsCUSD: (p.fixedSenderDenominations || []).filter(d => d <= balance).slice(0, 10),
        fixedRecipientAmounts: (p.fixedRecipientDenominations || []).slice(0, 10),
        minAmountCUSD: p.minSenderDenomination,
        maxAmountCUSD: p.maxSenderDenomination ? Math.min(p.maxSenderDenomination, balance) : null,
        redeemInstruction: p.redeemInstruction?.concise || null,
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
  description: "List available gift card brands for a country.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code"),
  }),
  func: async ({ countryCode }) => {
    try {
      countryCode = sanitizeCountryCode(countryCode);
      const products = await getGiftCardProducts(countryCode);
      const balance = await getCachedReloadlyBalance();
      const brands = new Map<string, { brandName: string; category: string | null; products: number; minPrice: number; maxPrice: number; currency: string }>();
      for (const p of products) {
        const existing = brands.get(p.brand.brandName);
        const min = p.minSenderDenomination ?? p.fixedSenderDenominations?.[0] ?? 0;
        const max = p.maxSenderDenomination ?? p.fixedSenderDenominations?.slice(-1)[0] ?? 0;
        if (existing) {
          existing.products++;
          existing.minPrice = Math.min(existing.minPrice, min);
          existing.maxPrice = Math.min(Math.max(existing.maxPrice, max), balance);
        } else {
          brands.set(p.brand.brandName, { brandName: p.brand.brandName, category: p.category?.name || null, products: 1, minPrice: min, maxPrice: Math.min(max, balance), currency: p.senderCurrencyCode });
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
  description: "Buy a gift card by productId. Amount in cUSD.",
  schema: z.object({
    productId: z.number().describe("Product ID from search_gift_cards"),
    amount: z.number().describe("Amount in cUSD"),
    recipientEmail: z.string().describe("Delivery email"),
    quantity: z.number().optional().nullable().describe("Number of cards (default 1)"),
  }),
  func: async ({ productId, amount, recipientEmail, quantity }) => {
    const { total } = calculateTotalPayment(amount);
    return JSON.stringify({
      status: 'payment_required',
      service: 'buy_gift_card',
      productAmount: amount,
      totalWithFee: total,
      currency: 'cUSD',
      details: { productId, unitPrice: amount, recipientEmail, quantity: quantity || 1 },
      message: `Gift card purchase requires ${total} cUSD payment (includes service fee). Use the order_confirmation flow for Telegram/A2A, or the x402 REST API / MCP endpoint for direct execution.`,
    });
  },
};

/**
 * Tool 10: Get gift card redeem code
 */
export const getGiftCardCodeTool: Tool = {
  name: "get_gift_card_code",
  description: "Get redeem code/PIN for a purchased gift card.",
  schema: z.object({
    transactionId: z.number().describe("Transaction ID from buy_gift_card"),
  }),
  func: async ({ transactionId }, ctx) => {
    try {
      // Ownership check: verify a receipt exists for this transactionId
      // and belongs to the current user (prevents guessing sequential IDs)
      const receipt = await getReceiptByReloadlyId(transactionId);
      if (!receipt) {
        return JSON.stringify({ error: 'No purchase found for this transaction ID. Make sure you have the correct ID from your gift card purchase.' });
      }
      // Ownership check is mandatory — if we can't verify, deny access.
      // Without this, anyone could enumerate sequential Reloadly transaction IDs.
      if (!ctx?.walletAddress) {
        return JSON.stringify({ error: 'Unable to verify ownership. Please try again.' });
      }
      if (receipt.payer === 'unknown' || receipt.payer.toLowerCase() !== ctx.walletAddress.toLowerCase()) {
        return JSON.stringify({ error: 'This transaction does not belong to you.' });
      }
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
  description: "Check what services are available in a country.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code"),
  }),
  func: async ({ countryCode }) => {
    try {
      countryCode = sanitizeCountryCode(countryCode);
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
  description: "Get active promotions and bonus deals for a country.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code"),
  }),
  func: async ({ countryCode }, ctx) => {
    try {
      countryCode = sanitizeCountryCode(countryCode);
      if (ctx) setUserCountry(ctx.userId, countryCode);
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

/**
 * Tool 13: Detect operator from phone number
 */
export const detectOperatorTool: Tool = {
  name: "detect_operator",
  description: "Detect the mobile operator for a phone number.",
  schema: z.object({
    phone: z.string().describe("Phone number to look up"),
    countryCode: z.string().describe("Country ISO code"),
  }),
  func: async ({ phone, countryCode }) => {
    try {
      phone = sanitizePhone(phone);
      countryCode = sanitizeCountryCode(countryCode);
      const op = await detectOperator(phone, countryCode);
      const balance = await getCachedReloadlyBalance();
      const fxRate = op.fx?.rate || 1;
      const descs = op.fixedAmountsDescriptions || {};
      // Compact plans: only include description when it exists, limit to 10
      const plans = (op.fixedAmounts || []).filter(a => a <= balance).slice(0, 10).map(usd => {
        const desc = descs[usd.toString()] || descs[usd.toFixed(2)];
        const plan: any = { cUSD: usd, local: Math.round(usd * fxRate) };
        if (desc) plan.desc = desc;
        return plan;
      });
      return JSON.stringify({
        valid: true,
        operatorId: op.operatorId,
        name: op.name,
        country: op.country?.name || countryCode,
        denominationType: op.denominationType,
        plans,
        minAmountCUSD: op.minAmount,
        maxAmountCUSD: op.maxAmount ? Math.min(op.maxAmount, balance) : balance,
        localCurrency: op.destinationCurrencyCode,
        fxRate,
      });
    } catch (error: any) {
      return JSON.stringify({
        valid: false,
        error: error.message,
        hint: 'Check the phone number and country code. The number may be invalid or the operator not supported.',
      });
    }
  },
};

/**
 * Tool 14: Schedule a task for later execution
 */
export const scheduleTaskTool: Tool = {
  name: "schedule_task",
  description: "Schedule a paid task for later execution (e.g. send airtime at 5pm).",
  schema: z.object({
    description: z.string().describe("Task description"),
    toolName: z.string().describe("Tool to execute: send_airtime, send_data, pay_bill, or buy_gift_card"),
    toolArgs: z.record(z.any()).describe("Tool arguments"),
    productAmount: z.number().describe("Amount in cUSD"),
    scheduledAt: z.string().describe("ISO 8601 datetime"),
  }),
  func: async ({ description, toolName, toolArgs, productAmount, scheduledAt }, ctx) => {
    if (!ctx) {
      return JSON.stringify({ error: 'Scheduling is only available in Telegram' });
    }

    const validTools = ['send_airtime', 'send_data', 'pay_bill', 'buy_gift_card'];
    if (!validTools.includes(toolName)) {
      return JSON.stringify({ error: `Invalid toolName. Must be one of: ${validTools.join(', ')}` });
    }

    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime()) || scheduledDate.getTime() < Date.now()) {
      return JSON.stringify({ error: 'scheduledAt must be a valid future datetime in ISO 8601 format' });
    }

    const taskId = await createScheduledTask({
      userId: ctx.userId,
      chatId: ctx.chatId,
      description,
      toolName,
      toolArgs,
      productAmount,
      scheduledAt: scheduledDate,
    });

    const { total } = calculateTotalPayment(productAmount);
    return JSON.stringify({
      status: 'scheduled',
      taskId,
      description,
      scheduledAt: scheduledDate.toISOString(),
      totalWithFee: total,
      message: `Task scheduled for ${scheduledDate.toLocaleString('en-US')}. You'll be asked to confirm payment when it's time. Total: ${total} cUSD.`,
    });
  },
};

/**
 * Tool 14: View scheduled tasks
 */
export const myTasksTool: Tool = {
  name: "my_tasks",
  description: "Show pending scheduled tasks.",
  schema: z.object({}),
  func: async (_args, ctx) => {
    if (!ctx) {
      return JSON.stringify({ error: 'Tasks are only available in Telegram' });
    }

    const tasks = await getUserScheduledTasks(ctx.userId);
    if (tasks.length === 0) {
      return JSON.stringify({ message: 'No scheduled tasks.' });
    }

    return JSON.stringify(tasks.map(t => ({
      taskId: t._id?.toString(),
      description: t.description,
      scheduledAt: t.scheduledAt,
      productAmount: t.productAmount,
      status: t.status,
    })));
  },
};

/**
 * Tool 15: Cancel a scheduled task
 */
export const cancelTaskTool: Tool = {
  name: "cancel_task",
  description: "Cancel a scheduled task by ID.",
  schema: z.object({
    taskId: z.string().describe("Task ID to cancel (from my_tasks)"),
  }),
  func: async ({ taskId }, ctx) => {
    if (!ctx) {
      return JSON.stringify({ error: 'Tasks are only available in Telegram' });
    }

    const cancelled = await cancelScheduledTask(taskId, ctx.userId);
    return JSON.stringify({
      success: cancelled,
      message: cancelled ? 'Task cancelled.' : 'Task not found or already executed.',
    });
  },
};

/**
 * Tool 16: Save a standing instruction / user preference
 */
export const saveInstructionTool: Tool = {
  name: "save_instruction",
  description: "Save a user preference, contact, or instruction to remember permanently.",
  schema: z.object({
    instruction: z.string().describe("What to remember"),
    category: z.enum(['preference', 'recurring', 'contact', 'alert', 'general']).describe("Category"),
  }),
  func: async ({ instruction, category }, ctx) => {
    if (!ctx) {
      return JSON.stringify({ error: 'Instructions are only available in Telegram' });
    }
    const id = await saveUserGoal(ctx.userId, instruction, category);
    return JSON.stringify({ saved: true, id, message: `Got it — I'll remember: "${instruction}"` });
  },
};

/**
 * Tool 17: View saved instructions
 */
export const getInstructionsTool: Tool = {
  name: "get_instructions",
  description: "Get all saved user preferences and instructions.",
  schema: z.object({}),
  func: async (_args, ctx) => {
    if (!ctx) {
      return JSON.stringify({ error: 'Instructions are only available in Telegram' });
    }
    const goals = await getUserGoals(ctx.userId);
    if (goals.length === 0) {
      return JSON.stringify({ message: 'No saved instructions yet. Tell me things to remember!' });
    }
    return JSON.stringify(goals.map(g => ({
      instruction: g.instruction,
      category: g.category,
      savedAt: g.createdAt,
    })));
  },
};

/**
 * Tool 18: Remove a saved instruction
 */
export const removeInstructionTool: Tool = {
  name: "remove_instruction",
  description: "Remove a saved instruction by matching text.",
  schema: z.object({
    instructionFragment: z.string().describe("Text to match and remove"),
  }),
  func: async ({ instructionFragment }, ctx) => {
    if (!ctx) {
      return JSON.stringify({ error: 'Instructions are only available in Telegram' });
    }
    const removed = await removeUserGoal(ctx.userId, instructionFragment);
    return JSON.stringify({
      success: removed,
      message: removed ? 'Instruction removed.' : 'No matching instruction found.',
    });
  },
};

/**
 * Tool 19: Convert currency using Reloadly FX rates
 */
export const convertCurrencyTool: Tool = {
  name: "convert_currency",
  description: "Convert between cUSD and local currency using live FX rates.",
  schema: z.object({
    amount: z.number().describe("Amount to convert"),
    fromCurrency: z.enum(["USD", "LOCAL"]).describe("USD or LOCAL"),
    countryCode: z.string().describe("Country ISO code"),
  }),
  func: async ({ amount, fromCurrency, countryCode }) => {
    try {
      countryCode = sanitizeCountryCode(countryCode);
      const fxData = await getFxRate(countryCode);
      if (!fxData) {
        return JSON.stringify({ error: `No FX rate available for country ${countryCode}` });
      }

      const { rate, currencyCode } = fxData;

      if (fromCurrency === "USD") {
        const localAmount = Math.round(amount * rate * 100) / 100;
        return JSON.stringify({
          from: { amount, currency: "USD" },
          to: { amount: localAmount, currency: currencyCode },
          fxRate: rate,
          description: `${amount} USD = ${localAmount.toLocaleString('en-US')} ${currencyCode}`,
        });
      } else {
        const usdAmount = Math.round((amount / rate) * 100) / 100;
        return JSON.stringify({
          from: { amount, currency: currencyCode },
          to: { amount: usdAmount, currency: "USD" },
          fxRate: rate,
          description: `${amount.toLocaleString('en-US')} ${currencyCode} = ${usdAmount} USD`,
        });
      }
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

// Scheduling context — passed as second arg to tool.func() by executeToolCalls.
// Previously was a module-level global that could be overwritten by concurrent requests.
export interface SchedulingContext {
  userId: string;
  chatId: number;
  walletAddress?: string;
}

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
  detectOperatorTool,
  getBillersTool,
  searchGiftCardsTool,
  getGiftCardsTool,
  getGiftCardCodeTool,
  checkCountryTool,
  getPromotionsTool,
  scheduleTaskTool,
  myTasksTool,
  cancelTaskTool,
  saveInstructionTool,
  getInstructionsTool,
  removeInstructionTool,
  convertCurrencyTool,
];

// Paid tool names for fast lookup
export const PAID_TOOL_NAMES = new Set(paidTools.map(t => t.name));

// All tools — paid tools return payment_required (never call Reloadly directly)
export const tools: Tool[] = [...freeTools, ...paidTools];
