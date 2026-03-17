import { tg, TgCallbackQuery } from './tg-client';
import { WalletManager } from '../wallet/manager';
import { PendingOrderStore } from './pending-orders';
import { verifyX402Payment, calculateTotalPayment } from '../blockchain/x402';
import { recordTransaction } from '../blockchain/erc8004';
import { submitAutoReputation, calculateRating } from '../blockchain/reputation';
import { userSettingsStore } from './user-settings';
import {
  sendAirtime, sendData,
  payBill as payReloadlyBill,
  buyGiftCard, getGiftCardRedeemCode,
} from '../apis/reloadly';
import { createReceipt, updateReceipt } from '../blockchain/service-receipts';
import { PAYMENT_TOKEN_SYMBOL } from '../blockchain/x402';
import { reservePaymentHash } from '../blockchain/replay-guard';
import { IS_TESTNET, CELO_CAIP2, TOKEN_SYMBOL, EXPLORER_BASE } from '../shared/constants';
import { invalidateReloadlyBalanceCache } from '../shared/balance-cache';

/**
 * Execute a Reloadly service tool by name
 */
async function executeServiceTool(
  toolName: string,
  toolArgs: Record<string, any>,
): Promise<any> {
  switch (toolName) {
    case 'send_airtime':
      return sendAirtime(toolArgs as any);
    case 'send_data':
      return sendData(toolArgs as any);
    case 'pay_bill':
      return payReloadlyBill(toolArgs as any);
    case 'buy_gift_card': {
      const result = await buyGiftCard(toolArgs as any);
      try {
        const codes = await getGiftCardRedeemCode(result.transactionId);
        return { ...result, redeemCodes: codes };
      } catch {
        return result;
      }
    }
    default:
      throw new Error(`Unknown service: ${toolName}`);
  }
}

/**
 * Format the result of a service execution for display
 */
function formatServiceResult(toolName: string, result: any): string {
  switch (toolName) {
    case 'send_airtime':
    case 'send_data': {
      let text = (
        `Operator: ${result.operatorName || 'Auto-detected'}\n` +
        `Amount: ${result.deliveredAmount} ${result.deliveredAmountCurrencyCode || ''}\n` +
        `Status: ${result.status}\n` +
        `Transaction ID: ${result.transactionId}`
      );
      if (result.pinDetail) {
        text += `\n\nPIN Code: ${result.pinDetail.code}`;
        if (result.pinDetail.ivr) text += `\nDial: ${result.pinDetail.ivr}`;
        if (result.pinDetail.validity) text += `\nValid: ${result.pinDetail.validity}`;
        if (result.pinDetail.info1) text += `\n${result.pinDetail.info1}`;
      }
      return text;
    }
    case 'pay_bill':
      return (
        `Status: ${result.status}\n` +
        `Reference: ${result.referenceId || result.id}\n` +
        `${result.message || ''}`
      );
    case 'buy_gift_card': {
      let text = (
        `Brand: ${result.product?.brand?.brandName || 'Gift Card'}\n` +
        `Amount: ${result.amount} ${result.currencyCode || ''}\n` +
        `Status: ${result.status}\n` +
        `Transaction ID: ${result.transactionId}`
      );
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
      }
      return text;
    }
    default:
      return JSON.stringify(result, null, 2);
  }
}

// Track in-progress withdrawals to prevent double-click race conditions
const withdrawalsInProgress = new Set<string>();

// Quick action button prompts
const quickActions: Record<string, string> = {
  quick_airtime: 'What country and phone number should I send airtime to?',
  quick_data: 'What country and phone number should I send data to?',
  quick_bill: 'What country and bill type do you want to pay?',
  quick_giftcard: 'What brand and amount for the gift card?',
};

/**
 * Route a callback query to the correct handler.
 * Direct pattern matching — no framework.
 */
export async function handleCallback(
  query: TgCallbackQuery,
  walletManager: WalletManager,
  pendingOrders: PendingOrderStore,
  recordSpending: (userId: string, amount: number) => void,
): Promise<void> {
  const data = query.data || '';
  if (data.length > 100) return; // Reject oversized callback data
  const userId = query.from.id.toString();
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  let match: RegExpMatchArray | null;

  // Helpers — shorthand for common operations on the callback's message
  const editMsg = (text: string, opts?: { parse_mode?: string; reply_markup?: any }) =>
    chatId && messageId
      ? tg('editMessageText', { chat_id: chatId, message_id: messageId, text, ...opts })
      : Promise.resolve();

  const answer = (text?: string, showAlert = false) =>
    tg('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: showAlert });

  const sendMsg = (text: string, opts?: { parse_mode?: string; reply_markup?: any }) =>
    chatId ? tg('sendMessage', { chat_id: chatId, text, ...opts }) : Promise.resolve();

  try {
    // ─── Quick Actions ───────────────────────────
    if (quickActions[data]) {
      await answer();
      await sendMsg(quickActions[data]);
      return;
    }

    // ─── Order Confirmation ──────────────────────
    if ((match = data.match(/^order_confirm_(order_\d{13}_[a-z0-9]{6})$/))) {
      const orderId = match[1];

      if (!userId) { await answer('Session error. Please try again.'); return; }

      const order = await pendingOrders.atomicTransition(orderId, 'pending_confirmation', 'pending_payment');
      if (!order) { await answer('Order expired or already confirmed.'); return; }

      if (order.telegramId !== userId) {
        await pendingOrders.updateStatus(orderId, 'pending_confirmation');
        await answer('Unauthorized.');
        return;
      }

      const { balance } = await walletManager.getBalance(order.telegramId);
      const balanceNum = parseFloat(balance);

      if (balanceNum < order.totalAmount) {
        await pendingOrders.updateStatus(orderId, 'pending_confirmation');
        const address = await walletManager.getAddress(order.telegramId);
        const shortage = order.totalAmount - balanceNum;
        await editMsg(
          `❌ Insufficient Balance\n\n` +
          `Required: ${order.totalAmount.toFixed(2)} ${TOKEN_SYMBOL}\n` +
          `Available: ${balance} ${TOKEN_SYMBOL}\n` +
          `Short by: ${shortage.toFixed(2)} ${TOKEN_SYMBOL}\n\n` +
          `Deposit ${TOKEN_SYMBOL} to:\n\`${address}\``,
          { parse_mode: 'Markdown' },
        );
        await answer('Insufficient balance');
        return;
      }

      const remaining = (balanceNum - order.totalAmount).toFixed(2);
      await editMsg(
        `Payment Request\n\n` +
        `${order.totalAmount.toFixed(2)} ${TOKEN_SYMBOL} from your wallet\n` +
        `(+ ~$0.001 gas fee)\n\n` +
        `Balance: ${balance} ${TOKEN_SYMBOL}\n` +
        `Remaining: ~${remaining} ${TOKEN_SYMBOL}`,
        {
          reply_markup: { inline_keyboard: [
            [{ text: 'Accept Payment', callback_data: `pay_accept_${orderId}` }],
            [{ text: 'Decline', callback_data: `pay_decline_${orderId}` }],
          ]},
        },
      );
      await answer();
      return;
    }

    // ─── Order Cancel ────────────────────────────
    if ((match = data.match(/^order_cancel_(order_\d{13}_[a-z0-9]{6})$/))) {
      const orderId = match[1];

      const order = await pendingOrders.atomicTransition(
        orderId, ['pending_confirmation', 'pending_payment'], 'cancelled',
      );
      if (!order) { await answer('Order already cancelled or expired.'); return; }

      if (userId && order.telegramId !== userId) {
        await pendingOrders.updateStatus(orderId, 'pending_confirmation');
        await answer('Unauthorized.');
        return;
      }

      await editMsg('Order cancelled.');
      await answer();
      return;
    }

    // ─── Payment Accept (Core Execution Path) ────
    if ((match = data.match(/^pay_accept_(order_\d{13}_[a-z0-9]{6})$/))) {
      const orderId = match[1];

      if (!userId) { await answer('Session error. Please try again.'); return; }

      const order = await pendingOrders.atomicTransition(orderId, 'pending_payment', 'processing');
      if (!order) { await answer('Order expired or already processing.'); return; }

      if (order.telegramId !== userId) {
        await pendingOrders.updateStatus(orderId, 'pending_payment');
        await answer('Unauthorized.');
        return;
      }

      await editMsg('⏳ Processing payment... (1/4)');
      await answer();

      let receiptId = '';
      try {
        const { balance: currentBalance } = await walletManager.getBalance(order.telegramId);
        if (parseFloat(currentBalance) < order.totalAmount) {
          await pendingOrders.updateStatus(orderId, 'failed', { error: 'Balance dropped below required amount' });
          const address = await walletManager.getAddress(order.telegramId);
          await editMsg(
            `❌ Insufficient Balance\n\n` +
            `Your balance dropped to ${currentBalance} ${TOKEN_SYMBOL} since confirmation.\n` +
            `Required: ${order.totalAmount.toFixed(2)} ${TOKEN_SYMBOL}\n\n` +
            `Deposit ${TOKEN_SYMBOL} to:\n${address}`,
          );
          return;
        }

        await editMsg('⏳ Transferring cUSD... (2/4)');
        const { txHash } = await walletManager.transferToAgent(order.telegramId, order.totalAmount);

        await editMsg('⏳ Verifying on-chain... (3/4)');
        const isReserved = await reservePaymentHash(txHash, 'telegram');
        if (!isReserved) throw new Error('Payment hash already used. This should not happen — contact support.');

        const verification = await verifyX402Payment(txHash, order.totalAmount);
        if (!verification.verified) throw new Error(`Payment verification failed: ${verification.error}`);

        const serviceType = order.action === 'airtime' ? 'airtime' :
                            order.action === 'data' ? 'data' :
                            order.action === 'bill' ? 'bill_payment' :
                            'gift_card' as const;
        receiptId = await createReceipt({
          paymentTxHash: txHash,
          payer: order.telegramId,
          paymentAmount: order.totalAmount.toString(),
          paymentToken: PAYMENT_TOKEN_SYMBOL,
          paymentNetwork: CELO_CAIP2,
          serviceType,
          source: 'telegram',
          serviceArgs: { toolName: order.toolName, ...order.toolArgs },
        });

        const actionLabel = order.action === 'airtime' ? 'Sending airtime' :
                            order.action === 'data' ? 'Activating data plan' :
                            order.action === 'bill' ? 'Paying bill' :
                            'Purchasing gift card';
        await editMsg(`⏳ ${actionLabel}... (4/4)`);
        const result = await executeServiceTool(order.toolName, order.toolArgs);

        await updateReceipt(receiptId, {
          status: 'success',
          reloadlyTransactionId: result.transactionId,
          reloadlyStatus: result.status,
          serviceResult: { toolName: order.toolName },
        });

        recordSpending(order.telegramId, order.productAmount);
        invalidateReloadlyBalanceCache();

        await recordTransaction({
          type: `${order.action}_telegram`,
          amount: order.productAmount,
          status: 'success',
          metadata: {
            telegramId: order.telegramId,
            toolName: order.toolName,
            paymentTx: txHash,
            source: 'telegram',
          },
        }).catch((err: any) => console.error('[ERC-8004 Record Error]', err.message));

        const userSettings = await userSettingsStore.get(order.telegramId);

        if (userSettings.autoReviewEnabled) {
          try {
            const userPrivateKey = await walletManager.exportPrivateKey(order.telegramId);
            const svcType = order.action === 'airtime' ? 'airtime' :
                            order.action === 'data' ? 'data' :
                            order.action === 'bill' ? 'bill_payment' : 'gift_card';
            await submitAutoReputation({ rating: 100, serviceType: svcType, success: true, userPrivateKey });
            console.log(`[Auto-Review] User ${order.telegramId} auto-rated 100/100 (5★) for ${svcType}`);
          } catch (error: any) {
            console.error('[Auto-Review Error]', error.message);
          }
        }

        await pendingOrders.updateStatus(orderId, 'completed', { txHash, result });
        const { balance: newBalance } = await walletManager.getBalance(order.telegramId);
        const explorerUrl = `${EXPLORER_BASE}/tx/${txHash}`;

        const completionText =
          `✅ ${order.action.charAt(0).toUpperCase() + order.action.slice(1)} Complete!\n\n` +
          `${formatServiceResult(order.toolName, result)}\n\n` +
          `Balance: ${newBalance} ${TOKEN_SYMBOL}`;

        if (userSettings.autoReviewEnabled) {
          await editMsg(completionText, {
            reply_markup: { inline_keyboard: [
              [{ text: '🔍 View Payment on Celoscan', url: explorerUrl }],
            ]},
          });
        } else {
          await editMsg(completionText + `\n\n⭐ How was your experience?`);
          await sendMsg('Rate this service:', {
            reply_markup: { inline_keyboard: [
              [
                { text: '⭐', callback_data: `rate_${orderId}_1` },
                { text: '⭐⭐', callback_data: `rate_${orderId}_2` },
                { text: '⭐⭐⭐', callback_data: `rate_${orderId}_3` },
              ],
              [
                { text: '⭐⭐⭐⭐', callback_data: `rate_${orderId}_4` },
                { text: '⭐⭐⭐⭐⭐', callback_data: `rate_${orderId}_5` },
              ],
              [{ text: 'Skip', callback_data: `rate_${orderId}_skip` }],
            ]},
          });
        }
      } catch (error: any) {
        console.error('[Payment Execute Error]', { orderId, userId: order.telegramId, error: error.message });

        if (receiptId) await updateReceipt(receiptId, { status: 'failed', error: error.message });
        await pendingOrders.updateStatus(orderId, 'failed', { error: error.message });

        // Categorize errors — never expose raw error.message to users
        let userMsg: string;
        if (error.message.includes('Insufficient balance') || error.message.includes('balance')) {
          userMsg = `Insufficient ${TOKEN_SYMBOL} balance. Deposit more via /wallet.`;
        } else if (error.message.includes('verification') || error.message.includes('INVALID')) {
          userMsg = 'Payment verification failed. Please try again.';
        } else if (error.message.includes('operator') || error.message.includes('OPERATOR')) {
          userMsg = 'Service provider error. Please check your details and try again.';
        } else {
          userMsg = 'Transaction failed. Please try again or contact support.';
        }

        await editMsg(`❌ Transaction Failed\n\n${userMsg}`);
      }
      return;
    }

    // ─── Payment Decline ─────────────────────────
    if ((match = data.match(/^pay_decline_(order_\d{13}_[a-z0-9]{6})$/))) {
      const orderId = match[1];
      const order = await pendingOrders.atomicTransition(orderId, 'pending_payment', 'cancelled');

      if (order && userId && order.telegramId !== userId) {
        await pendingOrders.updateStatus(orderId, 'pending_payment');
        await answer('Unauthorized.');
        return;
      }

      await editMsg('Payment declined. Order cancelled.');
      await answer();
      return;
    }

    // ─── Export Warning (2-step key export) ───────
    if ((match = data.match(/^export_warning_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }
      if (query.message?.chat.type !== 'private') {
        await answer('Use this in a private chat for security.', true);
        return;
      }

      await editMsg(
        `⚠️ Export Private Key\n\n` +
        `This will reveal your wallet's private key.\n` +
        `Anyone with this key has full control of your wallet.\n\n` +
        `Only continue if you understand the risks.`,
        {
          reply_markup: { inline_keyboard: [
            [{ text: 'Yes, show my key', callback_data: `export_confirm_${userId}` }],
            [{ text: 'Cancel', callback_data: `export_cancel_${userId}` }],
          ]},
        },
      );
      await answer();
      return;
    }

    // ─── Export Confirm ──────────────────────────
    if ((match = data.match(/^export_confirm_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }
      try {
        const privateKey = await walletManager.exportPrivateKey(userId);
        await editMsg(
          `Your Private Key (save it securely, then delete this message):\n\n` +
          `${privateKey}\n\n` +
          `WARNING: Anyone with this key controls your wallet. Never share it.`,
        );
      } catch (error: any) {
        console.error('[Export Error]', error.message);
        await editMsg('❌ Failed to export private key. Please try again.');
      }
      await answer();
      return;
    }

    // ─── Export Cancel ───────────────────────────
    if ((match = data.match(/^export_cancel_(\d+)$/))) {
      await editMsg('Private key export cancelled.');
      await answer();
      return;
    }

    // ─── Withdraw Confirm ────────────────────────
    if ((match = data.match(/^withdraw_confirm_(\d+_.+)$/))) {
      const parts = match[1].split('_');
      const targetUserId = parts[0];
      const amount = parseFloat(parts[1]);
      const toAddress = parts.slice(2).join('_');

      if (userId !== targetUserId) { await answer('Unauthorized'); return; }
      if (!amount || !isFinite(amount) || amount <= 0) { await answer('Invalid withdrawal amount.'); return; }
      if (!toAddress || !/^0x[0-9a-fA-F]{40}$/.test(toAddress)) { await answer('Invalid withdrawal address.'); return; }

      const withdrawKey = `${userId}_${amount}_${toAddress}`;
      if (withdrawalsInProgress.has(withdrawKey)) { await answer('Withdrawal already processing.'); return; }
      withdrawalsInProgress.add(withdrawKey);

      try {
        await editMsg('⏳ Processing withdrawal...');
        await answer();

        const result = await walletManager.withdraw(userId, toAddress, amount);
        const { balance: newBalance } = await walletManager.getBalance(userId);
        const explorerUrl = `${EXPLORER_BASE}/tx/${result.txHash}`;

        await editMsg(
          `✅ Withdrawal Complete!\n\n` +
          `Sent: ${result.amount} ${TOKEN_SYMBOL}\n` +
          `To: \`${result.to}\`\n\n` +
          `Balance: ${newBalance} ${TOKEN_SYMBOL}`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '🔍 View on Celoscan', url: explorerUrl }],
            ]},
          },
        );
      } catch (error: any) {
        console.error('[Withdraw Error]', error.message);
        const msg = error.message.includes('Insufficient') ? 'Insufficient balance for withdrawal.' : 'Withdrawal failed. Please try again.';
        await editMsg(`❌ ${msg}`);
      } finally {
        withdrawalsInProgress.delete(withdrawKey);
      }
      return;
    }

    // ─── Withdraw Cancel ─────────────────────────
    if ((match = data.match(/^withdraw_cancel_(\d+)$/))) {
      await editMsg('Withdrawal cancelled.');
      await answer();
      return;
    }

    // ─── Balance ─────────────────────────────────
    if ((match = data.match(/^balance_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }

      try {
        const { balance, address } = await walletManager.getBalance(userId);
        const explorerUrl = `${EXPLORER_BASE}/address/${address}`;

        await editMsg(
          `💰 Your Wallet\n\nBalance: ${balance} ${TOKEN_SYMBOL}\n\nAddress:\n\`${address}\``,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '🔍 View on Celoscan', url: explorerUrl }],
              [{ text: '🔄 Refresh Balance', callback_data: `balance_${userId}` }],
            ]},
          },
        );
      } catch (error: any) {
        console.error('[Balance Error]', error.message);
        await editMsg('❌ Could not fetch balance. Please try again.');
      }
      await answer();
      return;
    }

    // ─── History ─────────────────────────────────
    if ((match = data.match(/^history_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }
      await editMsg(
        `📊 Transaction History\n\n` +
        `Coming soon: View your recent airtime, data, bills, and gift card purchases.\n\n` +
        `For now, check your wallet address on Celoscan.`,
      );
      await answer();
      return;
    }

    // ─── Settings Close ──────────────────────────
    if ((match = data.match(/^settings_close_(\d+)$/))) {
      if (chatId && messageId) await tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
      await answer('Closed');
      return;
    }

    // ─── Toggle Auto-Review ──────────────────────
    if ((match = data.match(/^toggle_autoreview_(\d+)$/))) {
      if (userId !== match[1]) { await answer('Unauthorized'); return; }

      const newStatus = await userSettingsStore.toggleAutoReview(userId);
      const statusText = newStatus ? 'ON ✅' : 'OFF ❌';

      await editMsg(
        `⚙️ Wallet Settings\n\nChoose an option:`,
        {
          reply_markup: { inline_keyboard: [
            [{ text: `⭐ Auto-Review: ${statusText}`, callback_data: `toggle_autoreview_${userId}` }],
            [{ text: '🔑 Export Private Key', callback_data: `export_warning_${userId}` }],
            [{ text: '📊 Transaction History', callback_data: `history_${userId}` }],
            [{ text: '💰 Check Balance', callback_data: `balance_${userId}` }],
            [{ text: '❌ Close', callback_data: `settings_close_${userId}` }],
          ]},
        },
      );
      await answer(
        newStatus
          ? '⭐ Auto-review enabled: You\'ll automatically give 5★ after each service'
          : '⭐ Auto-review disabled: You\'ll be asked to rate after each service',
        true,
      );
      return;
    }

    // ─── Star Rating ─────────────────────────────
    if ((match = data.match(/^rate_(\d+)_(\d+|skip)$/))) {
      const orderId = match[1];
      const ratingStr = match[2];

      const order = await pendingOrders.get(orderId);
      if (!order || order.telegramId !== userId) { await answer('Order expired or not found.'); return; }
      if (order.status !== 'completed') { await answer('Order not completed yet.'); return; }

      if (chatId && messageId) await tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});

      if (ratingStr === 'skip') { await answer('Skipped rating'); return; }

      const stars = parseInt(ratingStr);
      if (stars < 1 || stars > 5) { await answer('Invalid rating'); return; }

      await answer(`${stars} star${stars > 1 ? 's' : ''}`);
      await sendMsg(`Thanks for rating ${stars}⭐!`);

      try {
        const userPrivateKey = await walletManager.exportPrivateKey(userId);
        const serviceType = order.action === 'airtime' ? 'airtime' :
                           order.action === 'data' ? 'data' :
                           order.action === 'bill' ? 'bill_payment' : 'gift_card';
        await submitAutoReputation({ rating: stars * 20, serviceType, success: true, userPrivateKey });
        console.log(`[Manual-Review] User ${userId} rated ${stars * 20}/100 (${stars}★) for ${serviceType}`);
      } catch (error: any) {
        console.error('[Manual-Review Error]', error.message);
      }
      return;
    }

  } catch (error: any) {
    console.error('[Callback Handler Error]', { data, error: error.message });
    tg('answerCallbackQuery', { callback_query_id: query.id, text: 'An error occurred.' }).catch(() => {});
  }
}
