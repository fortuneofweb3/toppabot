import { z } from "zod";
import {
  getOperators,
  getDataOperators,
  getBillers,
  getGiftCardProducts, searchGiftCards, getGiftCardRedeemCode,
  getCountryServices, getPromotions,
} from "../apis/reloadly";
import { calculateTotalPayment } from "../blockchain/x402";
import { createScheduledTask, getUserScheduledTasks, cancelScheduledTask } from "./scheduler";
import { saveUserGoal, getUserGoals, removeUserGoal } from "./goals";
import { setUserCountry } from "./user-activity";

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
      if (_schedulingContext) setUserCountry(_schedulingContext.userId, countryCode);
      const operators = await getOperators(countryCode);
      return JSON.stringify(operators.map(op => ({
        id: op.operatorId,
        name: op.name,
        denominationType: op.denominationType,
        fixedAmounts: op.fixedAmounts || [],
        localFixedAmounts: op.localFixedAmounts || [],
        localFixedAmountsDescriptions: op.localFixedAmountsDescriptions || {},
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
      if (_schedulingContext) setUserCountry(_schedulingContext.userId, countryCode);
      const operators = await getDataOperators(countryCode);
      return JSON.stringify(operators.map(op => ({
        operatorId: op.operatorId,
        name: op.name,
        isData: op.data,
        isBundle: op.bundle,
        denominationType: op.denominationType,
        fixedAmounts: op.fixedAmounts || [],
        fixedAmountsDescriptions: op.fixedAmountsDescriptions || {},
        localFixedAmounts: op.localFixedAmounts || [],
        localFixedAmountsDescriptions: op.localFixedAmountsDescriptions || {},
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
      if (_schedulingContext) setUserCountry(_schedulingContext.userId, countryCode);
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
      if (_schedulingContext) setUserCountry(_schedulingContext.userId, countryCode);
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
 * Tool 13: Schedule a task for later execution
 */
export const scheduleTaskTool: Tool = {
  name: "schedule_task",
  description: `Schedule a paid task (airtime, data, bill, gift card) for later execution. Use when the user says things like "send airtime at 5pm", "pay my bill tomorrow morning", "buy a gift card on Friday". The scheduledAt must be an ISO 8601 datetime string. The toolName and toolArgs must match exactly what you'd use for the corresponding paid tool.`,
  schema: z.object({
    description: z.string().describe("Human-readable description of the task (e.g. 'Send 500 NGN airtime to +234...')"),
    toolName: z.string().describe("The tool to execute: send_airtime, send_data, pay_bill, or buy_gift_card"),
    toolArgs: z.record(z.any()).describe("Arguments for the tool (same as you'd pass to the paid tool)"),
    productAmount: z.number().describe("Product amount in USD"),
    scheduledAt: z.string().describe("ISO 8601 datetime for when to execute (e.g. '2025-03-15T17:00:00Z')"),
  }),
  func: async ({ description, toolName, toolArgs, productAmount, scheduledAt }) => {
    // This is called by the agent — userId and chatId are injected by the caller
    // via the _schedulingContext (set before each agent run)
    const ctx = _schedulingContext;
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
      message: `Task scheduled for ${scheduledDate.toLocaleString()}. You'll be asked to confirm payment when it's time. Total: ${total} cUSD.`,
    });
  },
};

/**
 * Tool 14: View scheduled tasks
 */
export const myTasksTool: Tool = {
  name: "my_tasks",
  description: "Show the user's pending scheduled tasks. Use when user asks about their upcoming/scheduled tasks.",
  schema: z.object({}),
  func: async () => {
    const ctx = _schedulingContext;
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
  description: "Cancel a pending scheduled task by ID. Use when user wants to cancel a scheduled task.",
  schema: z.object({
    taskId: z.string().describe("Task ID to cancel (from my_tasks)"),
  }),
  func: async ({ taskId }) => {
    const ctx = _schedulingContext;
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
  description: `Save a standing instruction, preference, or goal for the user. Use this PROACTIVELY when the user tells you something you should remember permanently — like contact details, preferences, recurring needs, or alerts they want. Categories: "contact" (phone numbers, accounts), "preference" (default country, operator preference), "recurring" (monthly top-ups, regular bills), "alert" (notify about promos), "general" (anything else).`,
  schema: z.object({
    instruction: z.string().describe("The instruction to remember (e.g. 'Brother\\'s number is +2348147658721, MTN Nigeria')"),
    category: z.enum(['preference', 'recurring', 'contact', 'alert', 'general']).describe("Category of instruction"),
  }),
  func: async ({ instruction, category }) => {
    const ctx = _schedulingContext;
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
  description: "Retrieve the user's saved instructions, preferences, and goals. Use when user asks what you remember about them.",
  schema: z.object({}),
  func: async () => {
    const ctx = _schedulingContext;
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
  description: "Remove a saved instruction by matching text. Use when user wants to forget/remove a standing instruction.",
  schema: z.object({
    instructionFragment: z.string().describe("Part of the instruction text to match and remove"),
  }),
  func: async ({ instructionFragment }) => {
    const ctx = _schedulingContext;
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

// Scheduling context — set by the caller before each agent run so tools can access userId/chatId
let _schedulingContext: { userId: string; chatId: number } | null = null;

export function setSchedulingContext(ctx: { userId: string; chatId: number } | null) {
  _schedulingContext = ctx;
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
];

// Paid tool names for fast lookup
export const PAID_TOOL_NAMES = new Set(paidTools.map(t => t.name));

// All tools — paid tools return payment_required (never call Reloadly directly)
export const tools: Tool[] = [...freeTools, ...paidTools];
