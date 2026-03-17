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
  description: "Send mobile airtime top-up to any phone number across 170+ countries via Reloadly. Operator is auto-detected from the phone number. Amount MUST be in USD (use fixedAmountsCUSD values from get_operators). This is a PAID service — payment is required before execution.",
  schema: z.object({
    phone: z.string().describe("Recipient phone number (e.g. 08147658721)"),
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
    amount: z.number().describe("Amount in USD (cUSD). Use values from fixedAmountsCUSD or within minAmountCUSD-maxAmountCUSD range."),
  }),
  func: async ({ phone, countryCode, amount }) => {
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
  description: "List available mobile operators for a country. Use this to show the user which operators are supported for airtime top-ups.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
  }),
  func: async ({ countryCode }) => {
    try {
      if (_schedulingContext) setUserCountry(_schedulingContext.userId, countryCode);
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
  description: "List available mobile data plan operators for a country. Returns operators that offer data bundles. Use the operatorId from results to send data with send_data.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
  }),
  func: async ({ countryCode }) => {
    try {
      if (_schedulingContext) setUserCountry(_schedulingContext.userId, countryCode);
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
  description: "Send mobile data bundle to a phone number. Use get_data_plans first to find the operatorId. Amount MUST be in USD (use fixedAmountsCUSD values from get_data_plans). This is a PAID service — payment is required before execution.",
  schema: z.object({
    phone: z.string().describe("Recipient phone number"),
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
    amount: z.number().describe("Amount in USD (cUSD). Use values from fixedAmountsCUSD or within minAmountCUSD-maxAmountCUSD range."),
    operatorId: z.number().describe("Data operator ID from get_data_plans"),
  }),
  func: async ({ phone, countryCode, amount, operatorId }) => {
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
  description: "Pay a utility bill (electricity, water, TV, internet) via Reloadly. First use get_billers to find the billerId. Amount MUST be in USD. Use the FX rate from get_billers to convert local currency amounts. This is a PAID service — payment is required before execution.",
  schema: z.object({
    billerId: z.number().describe("Biller ID from get_billers"),
    accountNumber: z.string().describe("Customer's meter number, smartcard number, or account number"),
    amount: z.number().describe("Amount in USD (cUSD). Convert local currency using the fxRate from get_billers."),
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
  description: "List available utility billers for a country. Types: ELECTRICITY_BILL_PAYMENT, WATER_BILL_PAYMENT, TV_BILL_PAYMENT, INTERNET_BILL_PAYMENT.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
    type: z.string().optional().nullable().describe("Bill type filter: ELECTRICITY_BILL_PAYMENT, WATER_BILL_PAYMENT, TV_BILL_PAYMENT, INTERNET_BILL_PAYMENT"),
  }),
  func: async ({ countryCode, type }) => {
    try {
      if (_schedulingContext) setUserCountry(_schedulingContext.userId, countryCode);
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
  description: "Search for available gift cards by brand name (e.g. 'Amazon', 'Steam', 'Netflix', 'Spotify', 'PlayStation', 'Xbox', 'Uber', 'Google Play', 'Apple'). Returns product IDs needed to buy gift cards.",
  schema: z.object({
    query: z.string().describe("Brand or product name to search for (e.g. 'Steam', 'Netflix', 'Amazon')"),
    countryCode: z.string().optional().nullable().describe("Country ISO code to filter by (e.g. US, NG, KE)"),
  }),
  func: async ({ query, countryCode }) => {
    try {
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
  description: "List all available gift card brands for a specific country. Returns brands like Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, etc.",
  schema: z.object({
    countryCode: z.string().describe("Country ISO code (e.g. US, NG, KE, GB)"),
  }),
  func: async ({ countryCode }) => {
    try {
      const products = await getGiftCardProducts(countryCode);
      const balance = await getCachedReloadlyBalance();
      const brands = new Map<string, { brandName: string; category: string | null; products: number; minPrice: number; maxPrice: number; currency: string }>();
      for (const p of products) {
        const existing = brands.get(p.brand.brandName);
        const min = p.minSenderDenomination || p.fixedSenderDenominations?.[0] || 0;
        const max = p.maxSenderDenomination || p.fixedSenderDenominations?.slice(-1)[0] || 0;
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
  description: "Purchase a gift card. Use search_gift_cards first to get the productId. Amount MUST be in USD (use fixedAmountsCUSD from search_gift_cards). This is a PAID service — payment is required before execution.",
  schema: z.object({
    productId: z.number().describe("Product ID from search_gift_cards or get_gift_cards"),
    amount: z.number().describe("Amount in USD (cUSD). Use fixedAmountsCUSD values from search_gift_cards."),
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
 * Tool 13: Detect operator from phone number
 */
export const detectOperatorTool: Tool = {
  name: "detect_operator",
  description: "Auto-detect the mobile operator for a phone number. Use this to validate a phone number and find its operator before sending airtime or data. Returns operator details including supported amounts.",
  schema: z.object({
    phone: z.string().describe("Phone number to look up (e.g. +2348147658721 or 08147658721)"),
    countryCode: z.string().describe("Country ISO code (e.g. NG, KE, GH)"),
  }),
  func: async ({ phone, countryCode }) => {
    try {
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

/**
 * Tool 19: Convert currency using Reloadly FX rates
 */
export const convertCurrencyTool: Tool = {
  name: "convert_currency",
  description: "Convert between USD (cUSD) and a country's local currency using live FX rates. Provide a country code to get the rate. Useful when users ask about prices in their local currency or want to know how much local currency equals a USD amount.",
  schema: z.object({
    amount: z.number().describe("Amount to convert"),
    fromCurrency: z.enum(["USD", "LOCAL"]).describe("Source currency: 'USD' to convert from USD to local, 'LOCAL' to convert from local currency to USD"),
    countryCode: z.string().describe("Country ISO code for the local currency (e.g. NG for NGN, KE for KES, GH for GHS)"),
  }),
  func: async ({ amount, fromCurrency, countryCode }) => {
    try {
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
          description: `${amount} USD = ${localAmount.toLocaleString()} ${currencyCode}`,
        });
      } else {
        const usdAmount = Math.round((amount / rate) * 100) / 100;
        return JSON.stringify({
          from: { amount, currency: currencyCode },
          to: { amount: usdAmount, currency: "USD" },
          fxRate: rate,
          description: `${amount.toLocaleString()} ${currencyCode} = ${usdAmount} USD`,
        });
      }
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
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
