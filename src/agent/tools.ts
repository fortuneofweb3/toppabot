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
import { createScheduledTask, getUserScheduledTasks, cancelScheduledTask, createRecurringTask, getUserRecurringTasks, cancelRecurringTask } from "./scheduler";
import { saveUserGoal, getUserGoals, removeUserGoal } from "./goals";
import { setUserCountry } from "./user-activity";
import { sanitizeCountryCode, sanitizePhone } from "../shared/sanitize";
import { userSettingsStore } from "../bot/user-settings";
import { getReadableQuote, getAllBalances, SUPPORTED_TOKENS, getTokenBySymbol } from "../blockchain/swap";
// Prestmit/Relay imports kept for sell_order_status (existing order lookup) — disabled for new sells
import { getSellOrderByOrderId } from "../bot/sell-orders";

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
 * Format operator plans as compact text instead of JSON.
 * Reduces LLM processing time by ~60% — DeepSeek can copy-paste instead of reformatting.
 *
 * JSON: [{"cUSD":0.5,"local":600,"desc":"500MB Daily"},{"cUSD":1,"local":1206,"desc":"1GB"}]
 * Text: 0.50 cUSD (600 NGN) 500MB Daily | 1.00 cUSD (1206 NGN) 1GB
 */
function formatOperatorText(op: any, balance: number): string {
  const fxRate = op.fx?.rate || 1;
  const cur = op.destinationCurrencyCode || 'LOCAL';
  const descs = op.fixedAmountsDescriptions || {};
  const plans = (op.fixedAmounts || []).filter((a: number) => a <= balance).slice(0, 10).map((usd: number) => {
    const desc = descs[usd.toString()] || descs[usd.toFixed(2)];
    const local = Math.round(usd * fxRate);
    return `${usd.toFixed(2)} cUSD (${local} ${cur})${desc ? ' ' + desc : ''}`;
  });

  let text = `${op.name} [id:${op.operatorId}] ${op.denominationType}`;
  text += ` | 1 cUSD = ${fxRate} ${cur}`;
  if (op.denominationType === 'RANGE') {
    const max = op.maxAmount ? Math.min(op.maxAmount, balance) : balance;
    text += ` | Range: ${op.minAmount}-${max.toFixed(2)} cUSD`;
  }
  if (plans.length > 0) {
    text += '\n  ' + plans.join('\n  ');
  }
  return text;
}

/**
 * Validate that an amount is acceptable for a given operator.
 * Returns an error message string if invalid, or null if OK.
 */
function validateOperatorAmount(operator: any, amountCUSD: number): string | null {
  if (operator.denominationType === 'FIXED') {
    const fixed = operator.fixedAmounts as number[] | null;
    if (fixed && fixed.length > 0) {
      // Check if amount matches any fixed denomination (allow ±0.01 tolerance)
      const match = fixed.find((f: number) => Math.abs(f - amountCUSD) < 0.015);
      if (!match) {
        const available = fixed.slice(0, 8).map((f: number) => `${f.toFixed(2)} cUSD`).join(', ');
        return `${operator.name} only accepts fixed amounts: ${available}. Pick one of these.`;
      }
    }
  } else {
    // RANGE type
    if (operator.minAmount && amountCUSD < operator.minAmount) {
      return `${operator.name} requires at least ${operator.minAmount.toFixed(2)} cUSD. You requested ${amountCUSD.toFixed(2)} cUSD.`;
    }
    if (operator.maxAmount && amountCUSD > operator.maxAmount) {
      return `${operator.name} allows max ${operator.maxAmount.toFixed(2)} cUSD. You requested ${amountCUSD.toFixed(2)} cUSD.`;
    }
  }
  return null;
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

    // Validate amount against operator constraints before generating payment
    try {
      const operator = await detectOperator(phone, countryCode);
      const amountError = validateOperatorAmount(operator, amount);
      if (amountError) return JSON.stringify({ status: 'error', error: amountError });
    } catch (e: any) {
      // If operator detection fails, let it proceed — Reloadly will catch it later
    }

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
      if (operators.length === 0) return `No mobile operators found for ${countryCode.toUpperCase()}.`;
      const balance = await getCachedReloadlyBalance();
      return operators.map(op => formatOperatorText(op, balance)).join('\n\n');
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
      if (operators.length === 0) return `No data plan operators found for ${countryCode.toUpperCase()}.`;
      const balance = await getCachedReloadlyBalance();
      return operators.map(op => formatOperatorText(op, balance)).join('\n\n');
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

    // Validate amount against operator constraints before generating payment
    try {
      const operators = await getOperators(countryCode);
      const operator = operators.find(op => op.operatorId === operatorId);
      if (operator) {
        const amountError = validateOperatorAmount(operator, amount);
        if (amountError) return JSON.stringify({ status: 'error', error: amountError });
      }
    } catch (e: any) {
      // If operator lookup fails, let it proceed
    }

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
      if (billers.length === 0) return `No billers found for ${countryCode.toUpperCase()}${type ? ' (' + type + ')' : ''}.`;
      return billers.map(b => {
        const fxRate = b.fx?.rate || 1;
        const minCUSD = b.internationalAmountSupported
          ? (b.minInternationalTransactionAmount || Math.round((b.minLocalTransactionAmount / fxRate) * 100) / 100)
          : Math.round((b.minLocalTransactionAmount / fxRate) * 100) / 100;
        const maxCUSD = b.internationalAmountSupported
          ? (b.maxInternationalTransactionAmount || Math.round((b.maxLocalTransactionAmount / fxRate) * 100) / 100)
          : Math.round((b.maxLocalTransactionAmount / fxRate) * 100) / 100;
        const cur = b.localTransactionCurrencyCode;
        return `${b.name} [id:${b.id}] ${b.serviceType} | ${minCUSD}-${maxCUSD} cUSD (${b.minLocalTransactionAmount}-${b.maxLocalTransactionAmount} ${cur})`;
      }).join('\n');
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
      if (results.length === 0) return `No gift cards found for "${query}"${countryCode ? ' in ' + countryCode.toUpperCase() : ''}.`;
      const balance = await getCachedReloadlyBalance();
      return results.slice(0, 10).map(p => {
        const amounts = (p.fixedSenderDenominations || []).filter((d: number) => d <= balance).slice(0, 10);
        const recipientAmounts = (p.fixedRecipientDenominations || []).slice(0, 10);
        let text = `${p.productName} [productId:${p.productId}] ${p.brand.brandName} | ${p.country.isoName} ${p.recipientCurrencyCode}`;
        if (p.denominationType === 'FIXED' && amounts.length > 0) {
          const pairs = amounts.map((a: number, i: number) => recipientAmounts[i] ? `${a} cUSD (${recipientAmounts[i]} ${p.recipientCurrencyCode})` : `${a} cUSD`);
          text += '\n  ' + pairs.join(' | ');
        } else if (p.denominationType === 'RANGE') {
          const max = p.maxSenderDenomination ? Math.min(p.maxSenderDenomination, balance) : balance;
          text += ` | Range: ${(p.minSenderDenomination || 0).toFixed(2)}-${max.toFixed(2)} cUSD`;
        }
        if (p.redeemInstruction?.concise) text += `\n  Redeem: ${p.redeemInstruction.concise}`;
        return text;
      }).join('\n\n');
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
      const brands = new Map<string, { category: string | null; products: number; minPrice: number; maxPrice: number }>();
      for (const p of products) {
        const existing = brands.get(p.brand.brandName);
        const min = p.minSenderDenomination ?? p.fixedSenderDenominations?.[0] ?? 0;
        const max = p.maxSenderDenomination ?? p.fixedSenderDenominations?.slice(-1)[0] ?? 0;
        if (existing) {
          existing.products++;
          existing.minPrice = Math.min(existing.minPrice, min);
          existing.maxPrice = Math.min(Math.max(existing.maxPrice, max), balance);
        } else {
          brands.set(p.brand.brandName, { category: p.category?.name || null, products: 1, minPrice: min, maxPrice: Math.min(max, balance) });
        }
      }
      let text = `Gift cards in ${countryCode.toUpperCase()} (${products.length} products):\n`;
      text += Array.from(brands.entries()).slice(0, 20).map(([name, b]) => {
        return `${name} | ${b.minPrice.toFixed(2)}-${b.maxPrice.toFixed(2)} cUSD${b.category ? ' | ' + b.category : ''}`;
      }).join('\n');
      return text;
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
    recipientUserId: z.string().optional().nullable().describe("In groups: Telegram/WhatsApp user ID of the gift card recipient. Omit for general/giveaway."),
  }),
  func: async ({ productId, amount, recipientEmail, quantity, recipientUserId }) => {
    const { total } = calculateTotalPayment(amount);
    return JSON.stringify({
      status: 'payment_required',
      service: 'buy_gift_card',
      productAmount: amount,
      totalWithFee: total,
      currency: 'cUSD',
      details: { productId, unitPrice: amount, recipientEmail, quantity: quantity || 1, ...(recipientUserId ? { recipientUserId } : {}) },
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
      const s = await getCountryServices(countryCode);
      const lines = [`Services in ${s.countryCode}:`];
      if (s.airtime.available) lines.push(`Airtime: ${s.airtime.operators.map((o: any) => o.name).join(', ')}`);
      else lines.push('Airtime: not available');
      if (s.dataPlans.available) lines.push(`Data plans: ${s.dataPlans.operators.map((o: any) => o.name).join(', ')}`);
      else lines.push('Data plans: not available');
      if (s.bills.available) lines.push(`Bills: ${s.bills.total} billers (${Object.entries(s.bills.types).map(([t, n]) => `${n} ${t.replace(/_/g, ' ').toLowerCase()}`).join(', ')})`);
      else lines.push('Bills: not available');
      if (s.giftCards.available) lines.push(`Gift cards: ${s.giftCards.totalProducts} products (${s.giftCards.brands.slice(0, 10).join(', ')}${s.giftCards.brands.length > 10 ? '...' : ''})`);
      else lines.push('Gift cards: not available');
      return lines.join('\n');
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
      if (promotions.length === 0) return `No active promotions for ${countryCode.toUpperCase()}.`;
      return promotions.slice(0, 10).map((p: any) => {
        const title = p.title || p.title2 || 'Promotion';
        const desc = p.description ? p.description.slice(0, 150) : '';
        const dates = p.startDate && p.endDate ? ` (${p.startDate} to ${p.endDate})` : '';
        return `${title}${dates}${desc ? '\n  ' + desc : ''}`;
      }).join('\n');
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
  func: async ({ phone, countryCode }, ctx) => {
    try {
      phone = sanitizePhone(phone);
      countryCode = sanitizeCountryCode(countryCode);
      // Infer timezone from phone number on first use (fire-and-forget)
      if (ctx?.userId) {
        userSettingsStore.inferTimezoneIfNeeded(ctx.userId, phone).catch(() => {});
      }
      const op = await detectOperator(phone, countryCode);
      const balance = await getCachedReloadlyBalance();
      // Return structured JSON for detect_operator — fidelity check in graph.ts parses it
      const fxRate = op.fx?.rate || 1;
      const planText = formatOperatorText(op, balance);
      return JSON.stringify({
        valid: true,
        operatorId: op.operatorId,
        name: op.name,
        country: op.country?.name || countryCode,
        denominationType: op.denominationType,
        localCurrency: op.destinationCurrencyCode,
        fxRate,
        minAmountCUSD: op.minAmount,
        maxAmountCUSD: op.maxAmount ? Math.min(op.maxAmount, balance) : balance,
        plans: planText,
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

/**
 * Tool 20: Schedule a recurring payment
 */
export const scheduleRecurringTool: Tool = {
  name: "schedule_recurring",
  description: "Set up a recurring payment (daily, weekly, or monthly). Example: 'recharge 500 NGN airtime every Friday at 9am'.",
  schema: z.object({
    description: z.string().describe("Task description"),
    toolName: z.string().describe("Tool to execute: send_airtime, send_data, pay_bill, or buy_gift_card"),
    toolArgs: z.record(z.any()).describe("Tool arguments"),
    productAmount: z.number().describe("Amount in cUSD"),
    frequency: z.enum(['daily', 'weekly', 'monthly']).describe("How often to execute"),
    dayOfWeek: z.number().optional().nullable().describe("Day of week (0=Sun to 6=Sat) for weekly"),
    dayOfMonth: z.number().optional().nullable().describe("Day of month (1-31) for monthly"),
    time: z.string().describe("Time in HH:MM format (user's timezone)"),
  }),
  func: async ({ description, toolName, toolArgs, productAmount, frequency, dayOfWeek, dayOfMonth, time }, ctx) => {
    if (!ctx) {
      return JSON.stringify({ error: 'Recurring payments are only available in Telegram' });
    }

    const validTools = ['send_airtime', 'send_data', 'pay_bill', 'buy_gift_card'];
    if (!validTools.includes(toolName)) {
      return JSON.stringify({ error: `Invalid toolName. Must be one of: ${validTools.join(', ')}` });
    }

    if (!/^\d{2}:\d{2}$/.test(time)) {
      return JSON.stringify({ error: 'time must be in HH:MM format (e.g. "09:00")' });
    }

    if (frequency === 'weekly' && (dayOfWeek === undefined || dayOfWeek === null)) {
      return JSON.stringify({ error: 'dayOfWeek is required for weekly frequency (0=Sun to 6=Sat)' });
    }

    if (frequency === 'monthly' && (dayOfMonth === undefined || dayOfMonth === null)) {
      return JSON.stringify({ error: 'dayOfMonth is required for monthly frequency (1-31)' });
    }

    const timezone = await userSettingsStore.getTimezone(ctx.userId);

    const taskId = await createRecurringTask({
      userId: ctx.userId,
      chatId: ctx.chatId,
      description,
      toolName,
      toolArgs,
      productAmount,
      recurrence: {
        frequency,
        ...(dayOfWeek !== undefined && dayOfWeek !== null ? { dayOfWeek } : {}),
        ...(dayOfMonth !== undefined && dayOfMonth !== null ? { dayOfMonth } : {}),
        time,
      },
      timezone,
      maxFailures: 3,
    });

    const { total } = calculateTotalPayment(productAmount);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let scheduleDesc = `${frequency} at ${time}`;
    if (frequency === 'weekly' && dayOfWeek !== undefined && dayOfWeek !== null) {
      scheduleDesc = `every ${dayNames[dayOfWeek]} at ${time}`;
    } else if (frequency === 'monthly' && dayOfMonth !== undefined && dayOfMonth !== null) {
      scheduleDesc = `monthly on day ${dayOfMonth} at ${time}`;
    }

    return JSON.stringify({
      status: 'recurring_scheduled',
      taskId,
      description,
      schedule: scheduleDesc,
      timezone,
      totalPerExecution: total,
      message: `Recurring payment set up: ${description}. Runs ${scheduleDesc} (${timezone}). ${total} cUSD per execution. You'll be asked to confirm each time.`,
    });
  },
};

/**
 * Tool 21: List recurring tasks
 */
export const listRecurringTool: Tool = {
  name: "list_recurring",
  description: "Show all active recurring payments.",
  schema: z.object({}),
  func: async (_args, ctx) => {
    if (!ctx) {
      return JSON.stringify({ error: 'Recurring payments are only available in Telegram' });
    }

    const tasks = await getUserRecurringTasks(ctx.userId);
    if (tasks.length === 0) {
      return JSON.stringify({ message: 'No active recurring payments.' });
    }

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return JSON.stringify(tasks.map(t => {
      let schedule = `${t.recurrence.frequency} at ${t.recurrence.time}`;
      if (t.recurrence.frequency === 'weekly' && t.recurrence.dayOfWeek !== undefined) {
        schedule = `every ${dayNames[t.recurrence.dayOfWeek]} at ${t.recurrence.time}`;
      } else if (t.recurrence.frequency === 'monthly' && t.recurrence.dayOfMonth !== undefined) {
        schedule = `monthly on day ${t.recurrence.dayOfMonth} at ${t.recurrence.time}`;
      }
      return {
        taskId: t._id?.toString(),
        description: t.description,
        schedule,
        timezone: t.timezone,
        productAmount: t.productAmount,
        nextDueAt: t.nextDueAt,
        lastExecutedAt: t.lastExecutedAt,
      };
    }));
  },
};

/**
 * Tool 22: Cancel a recurring task
 */
export const cancelRecurringTool: Tool = {
  name: "cancel_recurring",
  description: "Cancel a recurring payment by ID.",
  schema: z.object({
    taskId: z.string().describe("Recurring task ID (from list_recurring)"),
  }),
  func: async ({ taskId }, ctx) => {
    if (!ctx) {
      return JSON.stringify({ error: 'Recurring payments are only available in Telegram' });
    }

    const cancelled = await cancelRecurringTask(taskId, ctx.userId);
    return JSON.stringify({
      success: cancelled,
      message: cancelled ? 'Recurring payment cancelled.' : 'Task not found or already cancelled.',
    });
  },
};

/**
 * Tool 23: Check all token balances
 */
export const checkAllBalancesTool: Tool = {
  name: "check_all_balances",
  description: "Show balances for all supported tokens (cUSD, CELO, USDC, USDT, cEUR) in the user's wallet.",
  schema: z.object({}),
  func: async (_args, ctx) => {
    if (!ctx?.walletAddress) {
      return JSON.stringify({ error: 'Wallet not available. Use /wallet to set up.' });
    }

    try {
      const balances = await getAllBalances(ctx.walletAddress as `0x${string}`);
      if (balances.length === 0) {
        return 'No tokens found in wallet.';
      }

      return balances
        .map(b => `${b.symbol}: ${parseFloat(b.balance).toFixed(4)}`)
        .join('\n');
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 24: Get swap quote
 */
export const swapQuoteTool: Tool = {
  name: "swap_quote",
  description: "Get a price quote for swapping between tokens (e.g. CELO → cUSD). Supported: cUSD, CELO, USDC, USDT, cEUR.",
  schema: z.object({
    tokenIn: z.string().describe("Token to swap from (e.g. CELO, USDC)"),
    tokenOut: z.string().describe("Token to swap to (e.g. cUSD)"),
    amount: z.number().describe("Amount of input token"),
  }),
  func: async ({ tokenIn, tokenOut, amount }) => {
    try {
      const quote = await getReadableQuote(tokenIn, tokenOut, amount);
      return `Swap ${quote.amountIn} ${quote.tokenIn} → ${quote.amountOut} ${quote.tokenOut} (rate: 1 ${quote.tokenIn} = ${quote.rate.toFixed(4)} ${quote.tokenOut})`;
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 25: Check sell rates for gift cards (Prestmit)
 */
export const checkSellRatesTool: Tool = {
  name: "check_sell_rates",
  description: "Check current buyback rates for selling gift cards for crypto.",
  schema: z.object({
    query: z.string().optional().nullable().describe("Search by brand name (optional)"),
  }),
  func: async () => {
    return JSON.stringify({
      status: 'coming_soon',
      message: 'Gift card selling is coming soon! We are integrating Cardtonic for direct crypto payouts. Check back later.',
    });
  },
};

/**
 * Tool 26: Sell a gift card
 */
export const sellGiftCardTool: Tool = {
  name: "sell_gift_card",
  description: "Sell a gift card for crypto (cUSD). Provide the card ID, amount, and card code/PIN.",
  schema: z.object({
    cardId: z.number().describe("Gift card subcategory ID from check_sell_rates"),
    amount: z.number().describe("Card face value"),
    cardNumber: z.string().describe("Gift card code/number"),
    cardPin: z.string().optional().nullable().describe("Gift card PIN (if applicable)"),
  }),
  func: async () => {
    return JSON.stringify({
      status: 'coming_soon',
      message: 'Gift card selling is coming soon! We are integrating Cardtonic for direct crypto payouts. Check back later.',
    });
  },
};

/**
 * Tool 27: Check sell order status
 */
export const sellOrderStatusTool: Tool = {
  name: "sell_order_status",
  description: "Check the status of a gift card sell order.",
  schema: z.object({
    orderId: z.string().describe("Sell order ID from sell_gift_card (e.g. sell_xxx)"),
  }),
  func: async ({ orderId }) => {
    try {
      // Check existing orders (users with pending orders can still check status)
      const order = await getSellOrderByOrderId(orderId);
      if (order) {
        return JSON.stringify({
          orderId: order.orderId,
          card: order.cardName,
          status: order.status,
          estimatedPayout: `~${order.estimatedCusd} cUSD (₦${order.payoutAmountLocal})`,
          ...(order.creditAmountCusd ? { creditedAmount: `${order.creditAmountCusd} cUSD` } : {}),
          ...(order.creditTxHash ? { txHash: order.creditTxHash } : {}),
          ...(order.rejectionReason ? { reason: order.rejectionReason } : {}),
          createdAt: order.createdAt,
          note: 'New sell orders are temporarily disabled. Cardtonic integration coming soon.',
        });
      }

      return JSON.stringify({
        status: 'coming_soon',
        message: 'Gift card selling is coming soon with our new Cardtonic integration. No active sell orders found.',
      });
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 28: Get bridge quote (USDT Tron → USDC Celo)
 */
export const bridgeQuoteTool: Tool = {
  name: "bridge_quote",
  description: "Get a quote for bridging USDT from Tron to USDC on Celo via Relay Protocol.",
  schema: z.object({
    tronAddress: z.string().describe("Sender's Tron address (base58 format)"),
    celoAddress: z.string().describe("Recipient's Celo address (0x format)"),
    amountUsdt: z.string().describe("Amount in USDT (e.g. '10.5')"),
  }),
  func: async () => {
    return JSON.stringify({
      status: 'coming_soon',
      message: 'Cross-chain bridging is coming soon as part of our Cardtonic gift card integration.',
    });
  },
};

/**
 * Tool 29: Check bridge status
 */
export const bridgeStatusTool: Tool = {
  name: "bridge_status",
  description: "Check the status of a Relay cross-chain bridge request.",
  schema: z.object({
    requestId: z.string().describe("Bridge request ID from bridge_quote"),
  }),
  func: async () => {
    return JSON.stringify({
      status: 'coming_soon',
      message: 'Cross-chain bridging is coming soon as part of our Cardtonic gift card integration.',
    });
  },
};

// Scheduling context — passed as second arg to tool.func() by executeToolCalls.
// Previously was a module-level global that could be overwritten by concurrent requests.
export interface SchedulingContext {
  userId: string;
  chatId: number;
  walletAddress?: string;
  groupId?: string;
}

// ─── Group Tools ─────────────────────────────────────────────

/**
 * Tool 30: Get group wallet info
 */
export const groupInfoTool: Tool = {
  name: "group_info",
  description: "Get group wallet balance, member list, and recent activity. Only works in group chats.",
  schema: z.object({}),
  func: async (_args, ctx) => {
    if (!ctx?.groupId) {
      return JSON.stringify({ error: 'This command only works in group chats. Use /group in a group.' });
    }
    try {
      const { getGroup, getGroupBalance, getMemberContributions, getGroupTransactions } = await import('../bot/groups');
      const { WalletManager } = await import('../wallet/manager');
      const { MongoWalletStore } = await import('../wallet/mongo-store');
      const wm = new WalletManager(new MongoWalletStore());

      const group = await getGroup(ctx.groupId);
      if (!group) {
        return JSON.stringify({ error: 'No group wallet set up. Admin can run /group enable.' });
      }

      const { balance } = await getGroupBalance(group, wm);
      const contributions = await getMemberContributions(ctx.groupId);
      const recentTxs = await getGroupTransactions(ctx.groupId, 5);

      return JSON.stringify({
        name: group.name,
        walletAddress: group.walletAddress,
        balance: `${parseFloat(balance).toFixed(2)} cUSD`,
        members: group.members.length,
        admin: group.adminUserId,
        contributions: contributions.slice(0, 10).map(c => ({ user: c.userId, total: c.total.toFixed(2) })),
        recentActivity: recentTxs.map(tx => ({
          date: tx.createdAt.toLocaleDateString(),
          type: tx.type,
          amount: tx.amount.toFixed(2),
          description: tx.description,
        })),
      });
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 31: Contribute to group wallet
 */
export const groupContributeTool: Tool = {
  name: "group_contribute",
  description: "Transfer cUSD from your personal wallet to the group wallet.",
  schema: z.object({
    amount: z.number().describe("Amount in cUSD to contribute to the group"),
  }),
  func: async ({ amount }, ctx) => {
    if (!ctx?.groupId) {
      return JSON.stringify({ error: 'This only works in group chats.' });
    }
    try {
      const { getGroup, contributeToGroup, getGroupBalance } = await import('../bot/groups');
      const { WalletManager } = await import('../wallet/manager');
      const { MongoWalletStore } = await import('../wallet/mongo-store');
      const wm = new WalletManager(new MongoWalletStore());

      const group = await getGroup(ctx.groupId);
      if (!group) {
        return JSON.stringify({ error: 'No group wallet set up. Admin can run /group enable.' });
      }

      const result = await contributeToGroup(group, ctx.userId, amount, wm);
      const { balance } = await getGroupBalance(group, wm);

      return JSON.stringify({
        status: 'success',
        contributed: `${amount.toFixed(2)} cUSD`,
        groupBalance: `${parseFloat(balance).toFixed(2)} cUSD`,
        txHash: result.txHash,
        message: `Successfully contributed ${amount.toFixed(2)} cUSD to the group wallet.`,
      });
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 32: Create a group poll for spending decisions
 */
export const groupCreatePollTool: Tool = {
  name: "group_create_poll",
  description: "Create a poll for the group to vote on a spending decision. Members vote yes/no, and the action executes when the approval threshold is met.",
  schema: z.object({
    description: z.string().describe("What the group is voting on (e.g. 'Buy $5 airtime for +234...')"),
    service: z.enum(['send_airtime', 'send_data', 'pay_bill', 'buy_gift_card']).describe("Service to spend on if approved"),
    amount: z.number().describe("Amount in cUSD"),
    details: z.record(z.any()).describe("Service details (phone, countryCode, operatorId, etc.)"),
  }),
  func: async ({ description, service, amount, details }, ctx) => {
    if (!ctx?.groupId) {
      return JSON.stringify({ error: 'Polls only work in group chats.' });
    }
    try {
      const { getGroup, getActivePolls } = await import('../bot/groups');
      const group = await getGroup(ctx.groupId);
      if (!group) {
        return JSON.stringify({ error: 'No group wallet set up. Admin can run /group enable.' });
      }

      // Check for existing active polls (limit to 3 concurrent)
      const active = await getActivePolls(ctx.groupId);
      if (active.length >= 3) {
        return JSON.stringify({ error: 'Too many active polls. Wait for existing polls to resolve.' });
      }

      // Return poll creation request — the bot layer (Telegram/WhatsApp) handles actual poll sending
      return JSON.stringify({
        type: 'create_poll',
        groupId: ctx.groupId,
        description,
        service,
        amount,
        details,
        threshold: Math.round((group.pollThreshold ?? 0.7) * 100),
        members: group.members.length,
        message: `Poll will be created for the group to vote. ${Math.round((group.pollThreshold ?? 0.7) * 100)}% approval needed (${Math.ceil(group.members.length * (group.pollThreshold ?? 0.7))} of ${group.members.length} members).`,
      });
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

/**
 * Tool 33: Generate transaction statement (PDF/Excel)
 */
export const generateStatementTool: Tool = {
  name: "generate_statement",
  description: "Generate a transaction statement as PDF or Excel. Works for personal wallet and group wallets.",
  schema: z.object({
    format: z.enum(['pdf', 'xlsx']).describe("Report format: pdf or xlsx"),
    startDate: z.string().optional().nullable().describe("Start date (ISO 8601 or natural, e.g. '2025-01-01')"),
    endDate: z.string().optional().nullable().describe("End date (ISO 8601 or natural)"),
    groupId: z.string().optional().nullable().describe("Group ID for group statement (omit for personal)"),
  }),
  func: async ({ format, startDate, endDate, groupId }, ctx) => {
    if (!ctx?.walletAddress) {
      return JSON.stringify({ error: 'Wallet not available. Use /wallet to set up.' });
    }
    try {
      const { generateReport } = await import('../reports/generator');

      const start = startDate ? new Date(startDate) : undefined;
      const end = endDate ? new Date(endDate) : undefined;
      if (start && isNaN(start.getTime())) return JSON.stringify({ error: 'Invalid startDate.' });
      if (end && isNaN(end.getTime())) return JSON.stringify({ error: 'Invalid endDate.' });

      let title = 'Personal Statement';
      let reportGroupId = groupId || (ctx.groupId ? ctx.groupId : undefined);
      if (reportGroupId) {
        const { getGroup } = await import('../bot/groups');
        const group = await getGroup(reportGroupId);
        title = group ? `Group: ${group.name}` : 'Group Statement';
      }

      const report = await generateReport({
        walletAddress: ctx.walletAddress,
        startDate: start,
        endDate: end,
        format,
        title,
        groupId: reportGroupId || undefined,
      });

      // Store in report cache for bot to retrieve and send as file
      const reportId = `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      reportCache.set(reportId, {
        buffer: report.buffer,
        filename: report.filename,
        mimeType: report.mimeType,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
      });

      return JSON.stringify({
        type: 'statement_report',
        reportId,
        filename: report.filename,
        format,
        message: `Your ${format.toUpperCase()} statement is ready. Sending the file now...`,
      });
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  },
};

// ─── Report Cache ─────────────────────────────────────────────

interface CachedReport {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  expiresAt: number;
}

const reportCache = new Map<string, CachedReport>();

// Cleanup expired reports every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, report] of reportCache) {
    if (now > report.expiresAt) reportCache.delete(id);
  }
}, 2 * 60 * 1000);

/**
 * Retrieve a generated report from cache (used by bot layer to send as file).
 */
export function getReportFromCache(reportId: string): CachedReport | null {
  const report = reportCache.get(reportId);
  if (!report) return null;
  if (Date.now() > report.expiresAt) {
    reportCache.delete(reportId);
    return null;
  }
  return report;
}

/**
 * Tool 34: Spend from group wallet on services
 *
 * Admin can execute immediately (bypass polls).
 * Non-admin members trigger a poll — action only executes when threshold is met.
 */
export const groupSpendTool: Tool = {
  name: "group_spend",
  description: "Spend from group wallet on airtime/data/bills/gift cards. Admin executes immediately; non-admin creates a poll for group approval.",
  schema: z.object({
    service: z.enum(['send_airtime', 'send_data', 'pay_bill', 'buy_gift_card']).describe("Service to spend on"),
    amount: z.number().describe("Amount in cUSD"),
    details: z.record(z.any()).describe("Service details (phone, countryCode, operatorId, etc.)"),
    description: z.string().optional().nullable().describe("Human-readable description of the spend"),
  }),
  func: async ({ service, amount, details, description }, ctx) => {
    if (!ctx?.groupId) {
      return JSON.stringify({ error: 'This only works in group chats.' });
    }
    try {
      const { getGroup, isGroupAdmin } = await import('../bot/groups');
      const group = await getGroup(ctx.groupId);
      if (!group) {
        return JSON.stringify({ error: 'No group wallet set up. Admin can run /group enable.' });
      }

      // Admin bypasses polls; non-admin bypasses if pollingEnabled === false
      if (isGroupAdmin(group, ctx.userId) || !(group.pollingEnabled ?? true)) {
        const { total } = calculateTotalPayment(amount);
        return JSON.stringify({
          status: 'payment_required',
          service,
          productAmount: amount,
          totalWithFee: total,
          currency: 'cUSD',
          payFrom: 'group',
          groupWalletId: group.walletId,
          groupWalletAddress: group.walletAddress,
          details: { ...details, amount, useLocalAmount: false },
          message: `Group spend: ${total} cUSD from group wallet for ${service} (includes service fee).`,
        });
      }

      // Non-admin with polling enabled: create a poll for group approval
      const desc = description || `${service.replace(/_/g, ' ')} — ${amount.toFixed(2)} cUSD`;
      return JSON.stringify({
        type: 'create_poll',
        groupId: ctx.groupId,
        description: desc,
        service,
        amount,
        details,
        threshold: Math.round((group.pollThreshold ?? 0.7) * 100),
        members: group.members.length,
        message: `This spend requires group approval. A poll will be created — ${Math.round((group.pollThreshold ?? 0.7) * 100)}% of members must vote yes.`,
      });
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
  scheduleRecurringTool,
  listRecurringTool,
  cancelRecurringTool,
  saveInstructionTool,
  getInstructionsTool,
  removeInstructionTool,
  convertCurrencyTool,
  checkAllBalancesTool,
  swapQuoteTool,
  checkSellRatesTool,
  sellGiftCardTool,
  sellOrderStatusTool,
  bridgeQuoteTool,
  bridgeStatusTool,
  groupInfoTool,
  groupContributeTool,
  groupSpendTool,
  groupCreatePollTool,
  generateStatementTool,
];

// Paid tool names for fast lookup
export const PAID_TOOL_NAMES = new Set(paidTools.map(t => t.name));

// All tools — paid tools return payment_required (never call Reloadly directly)
export const tools: Tool[] = [...freeTools, ...paidTools];
