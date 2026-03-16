import { Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { WalletManager } from '../wallet/manager';
import { PendingOrderStore } from './pending-orders';
import { verifyX402Payment, calculateTotalPayment } from '../blockchain/x402';
import { recordTransaction } from '../blockchain/erc8004';
import { submitAutoReputation, calculateRating } from '../blockchain/reputation';
import {
  sendAirtime, sendData,
  payBill as payReloadlyBill,
  buyGiftCard, getGiftCardRedeemCode,
} from '../apis/reloadly';

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
    case 'send_data':
      return (
        `Operator: ${result.operatorName || 'Auto-detected'}\n` +
        `Amount: ${result.deliveredAmount} ${result.deliveredAmountCurrencyCode || ''}\n` +
        `Status: ${result.status}\n` +
        `Transaction ID: ${result.transactionId}`
      );
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
      const order = pendingOrders.get(orderId);

      if (!order || !userId || order.telegramId !== userId) {
        await ctx.answerCbQuery('Order expired or not found.');
        return;
      }

      // Check balance
      const { balance } = await walletManager.getBalance(order.telegramId);
      const balanceNum = parseFloat(balance);

      if (balanceNum < order.totalAmount) {
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

      // Show payment acceptance screen
      pendingOrders.updateStatus(orderId, 'pending_payment');
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
      const order = pendingOrders.get(orderId);
      if (order) {
        pendingOrders.updateStatus(orderId, 'cancelled');
        pendingOrders.remove(orderId);
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
    const order = pendingOrders.get(orderId);

    if (!order || !userId || order.telegramId !== userId) {
      await ctx.answerCbQuery('Order expired or not found.');
      return;
    }

    pendingOrders.updateStatus(orderId, 'processing');
    await ctx.editMessageText('⏳ Processing payment... (1/4)');
    await ctx.answerCbQuery();

    try {
      // Step 1: Transfer cUSD from user wallet → agent wallet
      await ctx.editMessageText('⏳ Transferring cUSD... (2/4)');
      const { txHash } = await walletManager.transferToAgent(
        order.telegramId,
        order.totalAmount,
      );

      // Step 2: Verify payment on-chain (reuses existing x402 verification)
      await ctx.editMessageText('⏳ Verifying on-chain... (3/4)');
      const verification = await verifyX402Payment(txHash, order.totalAmount);
      if (!verification.verified) {
        throw new Error(`Payment verification failed: ${verification.error}`);
      }

      // Step 3: Execute the Reloadly service
      const actionLabel = order.action === 'airtime' ? 'Sending airtime' :
                          order.action === 'data' ? 'Activating data plan' :
                          order.action === 'bill' ? 'Paying bill' :
                          'Purchasing gift card';
      await ctx.editMessageText(`⏳ ${actionLabel}... (4/4)`);
      const result = await executeServiceTool(order.toolName, order.toolArgs);

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
      }).catch(() => {}); // Non-critical

      // Step 6: Auto-submit reputation review (opt-out via env var)
      if (process.env.AUTO_REPUTATION_ENABLED !== 'false') {
        try {
          const userPrivateKey = await walletManager.exportPrivateKey(order.telegramId);
          const serviceType = order.action === 'airtime' ? 'airtime' :
                             order.action === 'data' ? 'data' :
                             order.action === 'bill' ? 'bill_payment' :
                             'gift_card';
          const rating = calculateRating(true); // Success = 100/100

          await submitAutoReputation({
            rating,
            serviceType,
            success: true,
            userPrivateKey,
          });
          console.log(`[Auto-Reputation] User ${order.telegramId} rated ${rating}/100 for ${serviceType}`);
        } catch (error: any) {
          console.error('[Auto-Reputation Error]', error.message);
          // Non-critical - don't fail the transaction
        }
      }

      // Step 7: Show result
      pendingOrders.updateStatus(orderId, 'completed', { txHash, result });
      const { balance: newBalance } = await walletManager.getBalance(order.telegramId);

      const isTestnet = process.env.NODE_ENV !== 'production';
      const tokenSymbol = isTestnet ? 'USDC' : 'cUSD';
      const explorerUrl = isTestnet
        ? `https://alfajores.celoscan.io/tx/${txHash}`
        : `https://celoscan.io/tx/${txHash}`;

      await ctx.editMessageText(
        `✅ ${order.action.charAt(0).toUpperCase() + order.action.slice(1)} Complete!\n\n` +
        `${formatServiceResult(order.toolName, result)}\n\n` +
        `Balance: ${newBalance} ${tokenSymbol}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🔍 View Payment on Celoscan', url: explorerUrl }
            ]]
          }
        }
      );
    } catch (error: any) {
      console.error('[Payment Execute Error]', {
        orderId,
        userId: order.telegramId,
        error: error.message,
      });

      pendingOrders.updateStatus(orderId, 'failed', { error: error.message });

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
      const order = pendingOrders.get(orderId);
      if (order) {
        pendingOrders.updateStatus(orderId, 'cancelled');
        pendingOrders.remove(orderId);
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
      const toAddress = parts.slice(2).join('_'); // Address might not have underscores, but be safe

      if (ctx.from?.id.toString() !== userId) {
        await ctx.answerCbQuery('Unauthorized');
        return;
      }

      await ctx.editMessageText('⏳ Processing withdrawal...');
      await ctx.answerCbQuery();

      const result = await walletManager.withdraw(userId, toAddress, amount);
      const { balance: newBalance } = await walletManager.getBalance(userId);

      const isTestnet = process.env.NODE_ENV !== 'production';
      const tokenSymbol = isTestnet ? 'USDC' : 'cUSD';
      const explorerUrl = isTestnet
        ? `https://alfajores.celoscan.io/tx/${result.txHash}`
        : `https://celoscan.io/tx/${result.txHash}`;

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
      const isTestnet = process.env.NODE_ENV !== 'production';
      const tokenSymbol = isTestnet ? 'USDC' : 'cUSD';

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
}
