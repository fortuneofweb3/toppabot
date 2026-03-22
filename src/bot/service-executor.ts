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
 * Execute a Reloadly service tool by name
 */
export async function executeServiceTool(
  toolName: string,
  toolArgs: Record<string, any>,
): Promise<any> {
  const args = sanitizeToolArgs(toolName, toolArgs);

  // Normalize gift card args: LLM sometimes generates toolArgs with `amount` instead
  // of `unitPrice` when it creates order_confirmation directly (bypassing tool short-circuit).
  // Reloadly requires `unitPrice`.
  if (toolName === 'buy_gift_card' && args.unitPrice == null && args.amount != null) {
    args.unitPrice = args.amount;
    delete args.amount;
  }

  switch (toolName) {
    case 'send_airtime':
      return sendAirtime(args as any);
    case 'send_data':
      return sendData(args as any);
    case 'pay_bill':
      return payReloadlyBill(args as any);
    case 'buy_gift_card': {
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
      // User can ask the agent later: "get code for transaction <id>"
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
