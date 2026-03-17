import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
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
      // Auto-fetch redeem codes for gift cards
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
        text += `\n\nRedeem Code(s): ${JSON.stringify(result.redeemCodes)}`;
      }
      return text;
    }
    default:
      return JSON.stringify(result, null, 2);
  }
}

// Track in-progress withdrawals to prevent double-click race conditions
const withdrawalsInProgress = new Set<string>();

/**
 * Register all inline keyboard callback handlers on the bot
 */
export function registerHandlers(
  bot: any,
  walletManager: WalletManager,
  pendingOrders: PendingOrderStore,
  recordSpending: (userId: string, amount: number) => void,
) {
  // ─── Order Confirmation ───────────────────────────

  bot.action(/^order_confirm_(.+)$/, async (ctx: Context) => {
    try {
      const orderId = (ctx as any).match[1];
      const userId = ctx.from?.id.toString();

      if (!userId) {
        await ctx.answerCbQuery('Error');
        return;
      }

      // Atomic: only transition if status is still pending_confirmation (prevents double-click)
      const order = await pendingOrders.atomicTransition(orderId, 'pending_confirmation', 'pending_payment');

      if (!order) {
        // Either expired, not found, or already confirmed by another click
        await ctx.answerCbQuery('Order expired or already confirmed.');
        return;
      }

      // Server-side ownership check — never trust callback data alone
      if (order.telegramId !== userId) {
        // Revert the transition since this isn't the order owner
        await pendingOrders.updateStatus(orderId, 'pending_confirmation');
        await ctx.answerCbQuery('Unauthorized.');
        return;
      }

      // Check balance
      const { balance } = await walletManager.getBalance(order.telegramId);
      const balanceNum = parseFloat(balance);

      if (balanceNum < order.totalAmount) {
        // Revert to pending_confirmation so user can try again after depositing
        await pendingOrders.updateStatus(orderId, 'pending_confirmation');
        const address = await walletManager.getAddress(order.telegramId);
        const shortage = order.totalAmount - balanceNum;
        await ctx.editMessageText(
          `❌ Insufficient Balance\n\n` +
          `Required: ${order.totalAmount.toFixed(2)} cUSD\n` +
          `Available: ${balance} cUSD\n` +
          `Short by: ${shortage.toFixed(2)} cUSD\n\n` +
          `Deposit cUSD to:\n\`${address}\``,
          { parse_mode: 'Markdown' }
        );
        await ctx.answerCbQuery('Insufficient balance');
        return;
      }

      // Show payment acceptance screen (status already transitioned atomically above)
      const remaining = (balanceNum - order.totalAmount).toFixed(2);

      await ctx.editMessageText(
        `Payment Request\n\n` +
        `${order.totalAmount.toFixed(2)} cUSD from your wallet\n` +
        `(+ ~$0.001 gas fee)\n\n` +
        `Balance: ${balance} cUSD\n` +
        `Remaining: ~${remaining} cUSD`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Accept Payment', `pay_accept_${orderId}`)],
          [Markup.button.callback('Decline', `pay_decline_${orderId}`)],
        ]),
      );
      await ctx.answerCbQuery();
    } catch (error: any) {
      console.error('[Order Confirm Error]', error.message);
      await ctx.answerCbQuery('An error occurred.');
    }
  });

  // ─── Order Cancel ─────────────────────────────────

  bot.action(/^order_cancel_(.+)$/, async (ctx: Context) => {
    try {
      const orderId = (ctx as any).match[1];
      const userId = ctx.from?.id.toString();

      // Atomic cancel — only from pre-payment states (can't cancel mid-processing)
      const order = await pendingOrders.atomicTransition(
        orderId,
        ['pending_confirmation', 'pending_payment'],
        'cancelled',
      );

      if (order && userId && order.telegramId !== userId) {
        // Revert — not the owner
        await pendingOrders.updateStatus(orderId, 'pending_confirmation');
        await ctx.answerCbQuery('Unauthorized.');
        return;
      }

      await ctx.editMessageText('Order cancelled.');
      await ctx.answerCbQuery();
    } catch (error: any) {
      console.error('[Order Cancel Error]', error.message);
      await ctx.answerCbQuery('Error cancelling order.');
    }
  });

  // ─── Payment Accept (Core Execution Path) ────────

  bot.action(/^pay_accept_(.+)$/, async (ctx: Context) => {
    const orderId = (ctx as any).match[1];
    const userId = ctx.from?.id.toString();

    if (!userId) {
      await ctx.answerCbQuery('Error');
      return;
    }

    // Atomic: only transition if status is still pending_payment (prevents double-click double-payment)
    const order = await pendingOrders.atomicTransition(orderId, 'pending_payment', 'processing');

    if (!order) {
      // Either expired, not found, or already processing from another click
      await ctx.answerCbQuery('Order expired or already processing.');
      return;
    }

    // Server-side ownership check — never trust callback data alone
    if (order.telegramId !== userId) {
      await pendingOrders.updateStatus(orderId, 'pending_payment');
      await ctx.answerCbQuery('Unauthorized.');
      return;
    }

    await ctx.editMessageText('⏳ Processing payment... (1/4)');
    await ctx.answerCbQuery();

    let receiptId = '';
    try {
      // Re-check balance before transfer (user could have moved funds since confirmation)
      const { balance: currentBalance } = await walletManager.getBalance(order.telegramId);
      if (parseFloat(currentBalance) < order.totalAmount) {
        await pendingOrders.updateStatus(orderId, 'failed', { error: 'Balance dropped below required amount' });
        const address = await walletManager.getAddress(order.telegramId);
        await ctx.editMessageText(
          `Insufficient balance. Your balance dropped to ${currentBalance} cUSD since confirmation.\n\n` +
          `Required: ${order.totalAmount.toFixed(2)} cUSD\nDeposit to: ${address}`,
        );
        return;
      }

      // Step 1: Transfer cUSD from user wallet → agent wallet
      await ctx.editMessageText('⏳ Transferring cUSD... (2/4)');
      const { txHash } = await walletManager.transferToAgent(
        order.telegramId,
        order.totalAmount,
      );

      // Step 2: Reserve payment hash to prevent cross-channel replay attacks
      await ctx.editMessageText('⏳ Verifying on-chain... (3/4)');
      const isReserved = await reservePaymentHash(txHash, 'telegram');
      if (!isReserved) {
        throw new Error('Payment hash already used. This should not happen — contact support.');
      }

      const verification = await verifyX402Payment(txHash, order.totalAmount);
      if (!verification.verified) {
        throw new Error(`Payment verification failed: ${verification.error}`);
      }

      // Create receipt after payment is verified (tracks payment → service binding)
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

      // Step 3: Execute the Reloadly service
      const actionLabel = order.action === 'airtime' ? 'Sending airtime' :
                          order.action === 'data' ? 'Activating data plan' :
                          order.action === 'bill' ? 'Paying bill' :
                          'Purchasing gift card';
      await ctx.editMessageText(`⏳ ${actionLabel}... (4/4)`);
      const result = await executeServiceTool(order.toolName, order.toolArgs);

      // Update receipt with success
      await updateReceipt(receiptId, {
        status: 'success',
        reloadlyTransactionId: result.transactionId,
        reloadlyStatus: result.status,
        serviceResult: { toolName: order.toolName },
      });

      // Step 4: Record spending for rate limiting
      recordSpending(order.telegramId, order.productAmount);

      // Step 5: Record on ERC-8004 reputation
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

      // Step 6: Handle reputation review (auto or manual)
      const userSettings = await userSettingsStore.get(order.telegramId);

      if (userSettings.autoReviewEnabled) {
        // Auto-review: submit 5 stars immediately
        try {
          const userPrivateKey = await walletManager.exportPrivateKey(order.telegramId);
          const serviceType = order.action === 'airtime' ? 'airtime' :
                             order.action === 'data' ? 'data' :
                             order.action === 'bill' ? 'bill_payment' :
                             'gift_card';

          await submitAutoReputation({
            rating: 100, // 5 stars = 100/100
            serviceType,
            success: true,
            userPrivateKey,
          });
          console.log(`[Auto-Review] User ${order.telegramId} auto-rated 100/100 (5★) for ${serviceType}`);
        } catch (error: any) {
          console.error('[Auto-Review Error]', error.message);
          // Non-critical - don't fail the transaction
        }
      }

      // Step 7: Show result
      await pendingOrders.updateStatus(orderId, 'completed', { txHash, result });
      const { balance: newBalance } = await walletManager.getBalance(order.telegramId);

      const tokenSymbol = TOKEN_SYMBOL;
      const explorerUrl = `${EXPLORER_BASE}/tx/${txHash}`;

      // Show completion message
      const completionText =
        `✅ ${order.action.charAt(0).toUpperCase() + order.action.slice(1)} Complete!\n\n` +
        `${formatServiceResult(order.toolName, result)}\n\n` +
        `Balance: ${newBalance} ${tokenSymbol}`;

      if (userSettings.autoReviewEnabled) {
        // Auto-review enabled: just show result
        await ctx.editMessageText(completionText, {
          reply_markup: {
            inline_keyboard: [[
              { text: '🔍 View Payment on Celoscan', url: explorerUrl }
            ]]
          }
        });
      } else {
        // Manual review: prompt for rating
        await ctx.editMessageText(completionText + `\n\n⭐ How was your experience?`);
        await ctx.reply(
          'Rate this service:',
          Markup.inlineKeyboard([
            [
              Markup.button.callback('⭐', `rate_${orderId}_1`),
              Markup.button.callback('⭐⭐', `rate_${orderId}_2`),
              Markup.button.callback('⭐⭐⭐', `rate_${orderId}_3`),
            ],
            [
              Markup.button.callback('⭐⭐⭐⭐', `rate_${orderId}_4`),
              Markup.button.callback('⭐⭐⭐⭐⭐', `rate_${orderId}_5`),
            ],
            [
              Markup.button.callback('Skip', `rate_${orderId}_skip`),
            ]
          ])
        );
      }
    } catch (error: any) {
      console.error('[Payment Execute Error]', {
        orderId,
        userId: order.telegramId,
        error: error.message,
      });

      // Track failed service execution in receipt (payment was taken, service failed)
      if (receiptId) {
        await updateReceipt(receiptId, { status: 'failed', error: error.message });
      }

      await pendingOrders.updateStatus(orderId, 'failed', { error: error.message });

      let errorMsg = error.message;
      if (errorMsg.includes('Insufficient balance')) {
        // Balance error — show deposit address
        const address = await walletManager.getAddress(order.telegramId);
        errorMsg = `Insufficient cUSD balance. Deposit to:\n${address}`;
      } else if (!errorMsg.includes('verification') && !errorMsg.includes('INVALID')) {
        // Don't leak internal details
        errorMsg = 'Transaction failed. Please try again.';
      }

      await ctx.editMessageText(`Transaction Failed\n\n${errorMsg}`);
    }
  });

  // ─── Payment Decline ──────────────────────────────

  bot.action(/^pay_decline_(.+)$/, async (ctx: Context) => {
    try {
      const orderId = (ctx as any).match[1];
      const userId = ctx.from?.id.toString();

      // Atomic cancel — only from pending_payment state
      const order = await pendingOrders.atomicTransition(orderId, 'pending_payment', 'cancelled');

      if (order && userId && order.telegramId !== userId) {
        await pendingOrders.updateStatus(orderId, 'pending_payment');
        await ctx.answerCbQuery('Unauthorized.');
        return;
      }

      await ctx.editMessageText('Payment declined. Order cancelled.');
      await ctx.answerCbQuery();
    } catch (error: any) {
      await ctx.answerCbQuery('Error');
    }
  });

  // ─── Private Key Export ───────────────────────────

  bot.action(/^export_confirm_(.+)$/, async (ctx: Context) => {
    try {
      const userId = (ctx as any).match[1];
      if (ctx.from?.id.toString() !== userId) {
        await ctx.answerCbQuery('Unauthorized');
        return;
      }

      const privateKey = await walletManager.exportPrivateKey(userId);
      await ctx.editMessageText(
        `Your Private Key (save it securely, then delete this message):\n\n` +
        `${privateKey}\n\n` +
        `WARNING: Anyone with this key controls your wallet. Never share it.`,
      );
      await ctx.answerCbQuery();
    } catch (error: any) {
      await ctx.editMessageText(`Error: ${error.message}`);
      await ctx.answerCbQuery('Error');
    }
  });

  bot.action(/^export_cancel_(.+)$/, async (ctx: Context) => {
    await ctx.editMessageText('Private key export cancelled.');
    await ctx.answerCbQuery();
  });

  // ─── Withdrawal ───────────────────────────────────

  bot.action(/^withdraw_confirm_(.+)$/, async (ctx: Context) => {
    try {
      const data = (ctx as any).match[1];
      const parts = data.split('_');
      // Format: userId_amount_address
      const userId = parts[0];
      const amount = parseFloat(parts[1]);
      const toAddress = parts.slice(2).join('_');

      if (ctx.from?.id.toString() !== userId) {
        await ctx.answerCbQuery('Unauthorized');
        return;
      }

      // Validate parsed callback data (defense-in-depth)
      if (!amount || !isFinite(amount) || amount <= 0) {
        await ctx.answerCbQuery('Invalid withdrawal amount.');
        return;
      }
      if (!toAddress || !/^0x[0-9a-fA-F]{40}$/.test(toAddress)) {
        await ctx.answerCbQuery('Invalid withdrawal address.');
        return;
      }

      // Guard: prevent double-click — check synchronously before any await
      const withdrawKey = `${userId}_${amount}_${toAddress}`;
      if (withdrawalsInProgress.has(withdrawKey)) {
        await ctx.answerCbQuery('Withdrawal already processing.');
        return;
      }
      withdrawalsInProgress.add(withdrawKey);

      try {
        await ctx.editMessageText('⏳ Processing withdrawal...');
        await ctx.answerCbQuery();

        const result = await walletManager.withdraw(userId, toAddress, amount);
        const { balance: newBalance } = await walletManager.getBalance(userId);

        const tokenSymbol = TOKEN_SYMBOL;
        const explorerUrl = `${EXPLORER_BASE}/tx/${result.txHash}`;

        await ctx.editMessageText(
          `✅ Withdrawal Complete!\n\n` +
          `Sent: ${result.amount} ${tokenSymbol}\n` +
          `To: \`${result.to}\`\n\n` +
          `Balance: ${newBalance} ${tokenSymbol}`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '🔍 View on Celoscan', url: explorerUrl }
              ]]
            }
          }
        );
      } finally {
        withdrawalsInProgress.delete(withdrawKey);
      }
    } catch (error: any) {
      console.error('[Withdraw Error]', error.message);
      await ctx.editMessageText(`Withdrawal failed: ${error.message}`);
    }
  });

  bot.action(/^withdraw_cancel_(.+)$/, async (ctx: Context) => {
    await ctx.editMessageText('Withdrawal cancelled.');
    await ctx.answerCbQuery();
  });

  // ─── Settings Menu Handlers ───────────────────────

  bot.action(/^history_(.+)$/, async (ctx: Context) => {
    const userId = (ctx as any).match[1];

    if (ctx.from?.id.toString() !== userId) {
      await ctx.answerCbQuery('Unauthorized');
      return;
    }

    await ctx.editMessageText(
      `📊 Transaction History\n\n` +
      `Coming soon: View your recent airtime, data, bills, and gift card purchases.\n\n` +
      `For now, check your wallet address on Celoscan.`,
    );
    await ctx.answerCbQuery();
  });

  bot.action(/^balance_(.+)$/, async (ctx: Context) => {
    const userId = (ctx as any).match[1];

    if (ctx.from?.id.toString() !== userId) {
      await ctx.answerCbQuery('Unauthorized');
      return;
    }

    try {
      const { balance, address } = await walletManager.getBalance(userId);
      const tokenSymbol = TOKEN_SYMBOL;

      await ctx.editMessageText(
        `💰 Your Wallet\n\n` +
        `Balance: ${balance} ${tokenSymbol}\n\n` +
        `Address:\n\`${address}\``,
        { parse_mode: 'Markdown' }
      );
      await ctx.answerCbQuery();
    } catch (error: any) {
      await ctx.editMessageText(`❌ Error: ${error.message}`);
      await ctx.answerCbQuery('Error');
    }
  });

  bot.action(/^settings_close_(.+)$/, async (ctx: Context) => {
    await ctx.deleteMessage();
    await ctx.answerCbQuery('Closed');
  });

  bot.action(/^toggle_autoreview_(.+)$/, async (ctx: Context) => {
    try {
      const userId = (ctx as any).match[1];

      if (ctx.from?.id.toString() !== userId) {
        await ctx.answerCbQuery('Unauthorized');
        return;
      }

      const newStatus = await userSettingsStore.toggleAutoReview(userId);
      const statusText = newStatus ? 'ON ✅' : 'OFF ❌';

      await ctx.editMessageText(
        `⚙️ Wallet Settings\n\n` +
        `Choose an option:`,
        Markup.inlineKeyboard([
          [Markup.button.callback(`⭐ Auto-Review: ${statusText}`, `toggle_autoreview_${userId}`)],
          [Markup.button.callback('🔑 Export Private Key', `export_confirm_${userId}`)],
          [Markup.button.callback('📊 Transaction History', `history_${userId}`)],
          [Markup.button.callback('💰 Check Balance', `balance_${userId}`)],
          [Markup.button.callback('❌ Close', `settings_close_${userId}`)],
        ]),
      );

      await ctx.answerCbQuery(
        newStatus
          ? '⭐ Auto-review enabled: You\'ll automatically give 5★ after each service'
          : '⭐ Auto-review disabled: You\'ll be asked to rate after each service',
        { show_alert: true }
      );
    } catch (error: any) {
      console.error('[Toggle AutoReview Error]', error.message);
      await ctx.answerCbQuery('Error');
    }
  });

  // ─── Star Rating Handler ──────────────────────────

  bot.action(/^rate_(.+)_(\d+|skip)$/, async (ctx: Context) => {
    try {
      const orderId = (ctx as any).match[1];
      const ratingStr = (ctx as any).match[2];
      const userId = ctx.from?.id.toString();

      if (!userId) {
        await ctx.answerCbQuery('Error');
        return;
      }

      const order = await pendingOrders.get(orderId);
      if (!order || order.telegramId !== userId) {
        await ctx.answerCbQuery('Order expired or not found.');
        return;
      }

      // Only allow rating completed orders
      if (order.status !== 'completed') {
        await ctx.answerCbQuery('Order not completed yet.');
        return;
      }

      // Delete rating prompt
      await ctx.deleteMessage().catch(() => {});

      if (ratingStr === 'skip') {
        await ctx.answerCbQuery('Skipped rating');
        return;
      }

      const stars = parseInt(ratingStr);
      if (stars < 1 || stars > 5) {
        await ctx.answerCbQuery('Invalid rating');
        return;
      }
      const rating = stars * 20; // 1★=20, 2★=40, 3★=60, 4★=80, 5★=100

      await ctx.answerCbQuery(`${stars} star${stars > 1 ? 's' : ''}`);
      await ctx.reply(`Thanks for rating ${stars}⭐!`);

      // Submit rating on-chain
      try {
        const userPrivateKey = await walletManager.exportPrivateKey(userId);
        const serviceType = order.action === 'airtime' ? 'airtime' :
                           order.action === 'data' ? 'data' :
                           order.action === 'bill' ? 'bill_payment' :
                           'gift_card';

        await submitAutoReputation({
          rating,
          serviceType,
          success: true,
          userPrivateKey,
        });
        console.log(`[Manual-Review] User ${userId} rated ${rating}/100 (${stars}★) for ${serviceType}`);
      } catch (error: any) {
        console.error('[Manual-Review Error]', error.message);
        // Non-critical - user already saw confirmation
      }
    } catch (error: any) {
      console.error('[Rating Handler Error]', error.message);
      await ctx.answerCbQuery('Error');
    }
  });

  // ─── Quick Action Buttons (from /start) ───────────

  const quickActions: Record<string, string> = {
    quick_airtime: 'I want to send airtime. What country and phone number?',
    quick_data: 'I want to send a data bundle. What country and phone number?',
    quick_bill: 'I want to pay a utility bill. What country and bill type?',
    quick_giftcard: 'I want to buy a gift card. What brand and amount?',
  };

  for (const [action, prompt] of Object.entries(quickActions)) {
    bot.action(action, async (ctx: Context) => {
      await ctx.answerCbQuery();
      await ctx.reply(prompt);
    });
  }
}
