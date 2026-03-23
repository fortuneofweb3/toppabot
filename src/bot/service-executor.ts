/**
 * Shared service execution & formatting — used by both Telegram and WhatsApp bots.
 *
 * Contains Reloadly service dispatch (airtime, data, bills, gift cards)
 * and human-readable result formatting.
 */

import {
  sendAirtime, sendData,
  payBill as payReloadlyBill,
  buyGiftCard, getGiftCardRedeemCode,
  getOperators, detectOperator,
  getBillers, getGiftCardProduct, searchGiftCards,
} from '../apis/reloadly';
import { sanitizePhone, sanitizeCountryCode, sanitizeAccountNumber } from '../shared/sanitize';

/**
 * Sanitize toolArgs before passing to Reloadly — defense in depth.
 * The LLM generates these from user input and is an untrusted intermediary.
 */
function sanitizeToolArgs(toolName: string, args: Record<string, any>): Record<string, any> {
  const s = { ...args };
  // Sanitize fields common across tools
  if (s.phone != null) s.phone = sanitizePhone(String(s.phone));
  if (s.countryCode != null) s.countryCode = sanitizeCountryCode(String(s.countryCode));
  if (s.accountNumber != null) s.accountNumber = sanitizeAccountNumber(String(s.accountNumber));
  // Validate numeric fields
  if (s.amount != null) {
    s.amount = Number(s.amount);
    if (!isFinite(s.amount) || s.amount <= 0) throw new Error('Invalid amount');
  }
  if (s.operatorId != null) {
    s.operatorId = Number(s.operatorId);
    if (!Number.isInteger(s.operatorId) || s.operatorId <= 0) throw new Error('Invalid operator ID');
  }
  if (s.productId != null) {
    s.productId = Number(s.productId);
    if (!Number.isInteger(s.productId) || s.productId <= 0) throw new Error('Invalid product ID');
  }
  if (s.billerId != null) {
    s.billerId = Number(s.billerId);
    if (!Number.isInteger(s.billerId) || s.billerId <= 0) throw new Error('Invalid biller ID');
  }
  if (s.unitPrice != null) {
    s.unitPrice = Number(s.unitPrice);
    if (!isFinite(s.unitPrice) || s.unitPrice <= 0) throw new Error('Invalid unit price');
  }
  return s;
}

/**
 * Execute a Reloadly service tool by name.
 *
 * IMPORTANT: This runs AFTER the user has already paid cUSD on-chain.
 * Every arg from the LLM is validated against Reloadly's real data
 * before executing — never trust the LLM blindly.
 */
export async function executeServiceTool(
  toolName: string,
  toolArgs: Record<string, any>,
): Promise<any> {
  const args = sanitizeToolArgs(toolName, toolArgs);

  switch (toolName) {
    case 'send_airtime': {
      // Server-side: auto-detect operator from phone number (ignore any LLM-provided operatorId)
      const detected = await detectOperator(args.phone, args.countryCode);
      console.log(`[Validate] send_airtime: detected operator ${detected.name} (${detected.operatorId}) for ${args.phone}`);
      return sendAirtime({
        phone: args.phone,
        countryCode: args.countryCode,
        amount: args.amount,
        operatorId: detected.operatorId,
        useLocalAmount: args.useLocalAmount ?? false,
      });
    }

    case 'send_data': {
      // Server-side: validate operatorId belongs to the country, fallback to auto-detect
      let operatorId = args.operatorId;
      if (operatorId) {
        const operators = await getOperators(args.countryCode);
        const match = operators.find(op => op.operatorId === operatorId);
        if (!match) {
          console.warn(`[Validate] send_data: operatorId ${operatorId} not found in ${args.countryCode}, auto-detecting`);
          const detected = await detectOperator(args.phone, args.countryCode);
          operatorId = detected.operatorId;
          console.log(`[Validate] send_data: using auto-detected ${detected.name} (${detected.operatorId})`);
        } else {
          console.log(`[Validate] send_data: operatorId ${operatorId} confirmed as ${match.name} in ${args.countryCode}`);
        }
      } else {
        const detected = await detectOperator(args.phone, args.countryCode);
        operatorId = detected.operatorId;
        console.log(`[Validate] send_data: no operatorId provided, auto-detected ${detected.name} (${detected.operatorId})`);
      }
      return sendData({
        phone: args.phone,
        countryCode: args.countryCode,
        amount: args.amount,
        operatorId,
        useLocalAmount: args.useLocalAmount ?? false,
      });
    }

    case 'pay_bill': {
      // Server-side: validate billerId exists and amount is within range
      if (!args.billerId) throw new Error('Missing billerId');
      if (!args.countryCode) throw new Error('Missing countryCode for bill payment');

      const billers = await getBillers({ countryCode: args.countryCode });
      const match = billers.find((b: any) => b.id === args.billerId);
      if (!match) {
        throw new Error(`Biller ${args.billerId} not found in ${args.countryCode}. Use get_billers to find valid billers.`);
      }
      console.log(`[Validate] pay_bill: billerId ${args.billerId} confirmed as ${match.name}`);

      // Validate amount against biller's allowed range
      const fxRate = match.fx?.rate || 1;
      const minCUSD = match.internationalAmountSupported
        ? match.minInternationalTransactionAmount
        : Math.round((match.minLocalTransactionAmount / fxRate) * 100) / 100;
      const maxCUSD = match.internationalAmountSupported
        ? match.maxInternationalTransactionAmount
        : Math.round((match.maxLocalTransactionAmount / fxRate) * 100) / 100;
      if (minCUSD && args.amount < minCUSD) {
        throw new Error(`${match.name} requires at least ${minCUSD.toFixed(2)} cUSD. You requested ${args.amount.toFixed(2)} cUSD.`);
      }
      if (maxCUSD && args.amount > maxCUSD) {
        throw new Error(`${match.name} allows max ${maxCUSD.toFixed(2)} cUSD. You requested ${args.amount.toFixed(2)} cUSD.`);
      }

      return payReloadlyBill(args as any);
    }

    case 'buy_gift_card': {
      // Normalize: LLM sometimes uses `amount` instead of `unitPrice`
      if (args.unitPrice == null && args.amount != null) {
        args.unitPrice = args.amount;
        delete args.amount;
      }

      // Server-side: validate productId exists and price is within range
      if (args.productId) {
        try {
          let product = await getGiftCardProduct(args.productId).catch(() => null);
          
          // Fallback: if productId not found, try to resolve by product name (same pattern as airtime's operatorId auto-detect)
          if (!product && args.productName) {
            console.log(`[Executor] productId ${args.productId} not found, fallback search for "${args.productName}"`);
            const fallbackResults = await searchGiftCards(args.productName);
            if (fallbackResults.length > 0) {
              product = fallbackResults.find(p => p.productName === args.productName) || fallbackResults[0];
              args.productId = product.productId;
              console.log(`[Executor] Fallback resolved to productId: ${product.productId} (${product.productName})`);
            }
          }
          
          if (!product) {
            throw new Error(`Gift card product ${args.productId} not found`);
          }
          // Reject only explicitly unavailable products
          console.log(`[Executor] Product ${args.productId} status: ${product.status}`);
          if (product.status === 'UNAVAILABLE' || product.status === 'REMOVED') {
            throw new Error(`Gift card "${product.productName}" is no longer available (status: ${product.status}).`);
          }
          // Validate price is within allowed range
          if (product.denominationType === 'FIXED') {
            const fixedAmounts = product.fixedSenderDenominations || [];
            if (fixedAmounts.length > 0 && !fixedAmounts.includes(args.unitPrice)) {
              // Find closest valid amount
              const closest = fixedAmounts.reduce((prev: number, curr: number) =>
                Math.abs(curr - args.unitPrice) < Math.abs(prev - args.unitPrice) ? curr : prev
              );
              console.warn(`[Validate] buy_gift_card: ${args.unitPrice} not in fixed amounts, using closest: ${closest}`);
              args.unitPrice = closest;
            }
          } else if (product.denominationType === 'RANGE') {
            const min = product.minSenderDenomination || 0;
            const max = product.maxSenderDenomination || Infinity;
            if (args.unitPrice < min || args.unitPrice > max) {
              throw new Error(`Amount ${args.unitPrice} cUSD is outside the range ${min}-${max} cUSD for this gift card`);
            }
          }
          console.log(`[Validate] buy_gift_card: productId ${args.productId} confirmed (${product.productName})`);
        } catch (e: any) {
          if (e.message.includes('not found') || e.message.includes('outside the range') || e.message.includes('no longer available')) throw e;
          console.warn(`[Validate] buy_gift_card: product validation failed: ${e.message}`);
        }
      }

      const result = await buyGiftCard(args as any);
      // Retry fetching redeem codes — Reloadly may need a few seconds to generate them.
      // This is a read-only GET call (no duplicate purchase risk).
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const codes = await getGiftCardRedeemCode(result.transactionId);
          if (codes && (Array.isArray(codes) ? codes.length > 0 : true)) {
            return { ...result, redeemCodes: codes };
          }
        } catch (err: any) {
          console.warn(`[GiftCard] Code fetch attempt ${attempt + 1}/5 failed:`, err.message);
        }
        if (attempt < 4) await new Promise(r => setTimeout(r, 3000));
      }
      // Codes still not ready after retries — return without them.
      return { ...result, redeemCodesNote: 'Codes are being generated. Ask me for the code in a minute.' };
    }

    default:
      throw new Error(`Unknown service: ${toolName}`);
  }
}

/**
 * Format the result of a service execution for display
 */
export function formatServiceResult(toolName: string, result: any, order?: { toolArgs?: Record<string, any>; totalAmount?: number }): string {
  switch (toolName) {
    case 'send_airtime':
    case 'send_data': {
      const phone = order?.toolArgs?.phone || order?.toolArgs?.recipientPhone || '';
      const cUSD = order?.totalAmount;
      const localAmt = result.deliveredAmount;
      const localCur = result.deliveredAmountCurrencyCode || '';

      let text = `${result.operatorName || 'Operator'}\n`;
      if (phone) text += `${phone}\n`;
      if (cUSD != null && localAmt && localCur) {
        text += `${cUSD.toFixed(2)} cUSD (${localAmt} ${localCur})\n`;
      } else if (cUSD != null) {
        text += `${cUSD.toFixed(2)} cUSD\n`;
      } else if (localAmt) {
        text += `${localAmt} ${localCur}\n`;
      }
      text += `Ref: ${result.transactionId}`;
      if (result.pinDetail) {
        text += `\n\nPIN: ${result.pinDetail.code}`;
        if (result.pinDetail.ivr) text += `\nDial: ${result.pinDetail.ivr}`;
        if (result.pinDetail.validity) text += `\nValid: ${result.pinDetail.validity}`;
        if (result.pinDetail.info1) text += `\n${result.pinDetail.info1}`;
      }
      return text;
    }
    case 'pay_bill': {
      const cUSD = order?.totalAmount;
      const acct = order?.toolArgs?.accountNumber || order?.toolArgs?.subscriberAccountNumber || '';
      let text = '';
      if (acct) text += `Account: ${acct}\n`;
      if (cUSD != null) text += `${cUSD.toFixed(2)} cUSD\n`;
      text += `Ref: ${result.referenceId || result.id}`;
      if (result.message) text += `\n${result.message}`;
      return text;
    }
    case 'buy_gift_card': {
      const cUSD = order?.totalAmount;
      const brand = result.product?.brand?.brandName || 'Gift Card';
      let text = `${brand}\n`;
      if (cUSD != null) {
        text += `${cUSD.toFixed(2)} cUSD`;
        if (result.amount && result.currencyCode && result.currencyCode !== 'USD') {
          text += ` (${result.amount} ${result.currencyCode})`;
        }
        text += '\n';
      } else if (result.amount) {
        text += `${result.amount} ${result.currencyCode || ''}\n`;
      }
      text += `Ref: ${result.transactionId}`;
      if (result.redeemCodes) {
        if (Array.isArray(result.redeemCodes)) {
          const codes = result.redeemCodes.map((c: any) => {
            const parts = [];
            if (c.cardNumber) parts.push(`Card: ${c.cardNumber}`);
            if (c.pinCode) parts.push(`PIN: ${c.pinCode}`);
            return parts.length > 0 ? parts.join('\n') : JSON.stringify(c);
          }).join('\n---\n');
          text += `\n\nRedeem Code(s):\n${codes}`;
        } else {
          text += `\n\nRedeem Code: ${result.redeemCodes}`;
        }
      } else if (result.redeemCodesNote) {
        text += `\n\n${result.redeemCodesNote}`;
      }
      return text;
    }
    default:
      return JSON.stringify(result, null, 2);
  }
}
